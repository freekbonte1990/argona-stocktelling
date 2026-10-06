import {
  isCentrallyManaged,
  type CentralMasterApplySummary,
  type CentralMasterStatus,
  type CentralOfficeSummary,
} from "../../domain/centralMasterFile";
import { planCentralMasterApply } from "../../domain/centralMasterPlan";
import { CentralMasterError, type CentralMasterErrorKind, type CentralMasterSource } from "../ports/CentralMasterSource";
import type { CountingRepository } from "../ports/CountingRepository";

export type CentralMasterSyncOutcome =
  /** Een nieuwe master is lokaal toegepast. */
  | "applied"
  /** De lokaal toegepaste master is nog actueel — niets gewijzigd. */
  | "unchanged"
  /** Er loopt een telling: de nieuwe master is opgehaald/gevalideerd maar wordt pas toegepast nadat die telling afgerond/geannuleerd is. */
  | "deferred"
  /** Laatste succesvolle sync was net (zie `minIntervalMs`) — niets geprobeerd. */
  | "skipped-recent"
  /** Voor dit kantoor is (nog) geen master gepubliceerd. */
  | "not-found"
  /** Poging mislukt; lokale data ongewijzigd, de app werkt gewoon door. */
  | "failed";

export interface CentralMasterSyncResult {
  outcome: CentralMasterSyncOutcome;
  /** Discrete melding voor de UI (bootstrap-scherm), of `null` wanneer alles in orde is. */
  message: string | null;
  kind?: CentralMasterErrorKind;
  summary?: CentralMasterApplySummary;
}

export interface CentralMasterSyncOptions {
  /** Negeer de "recent gesynchroniseerd"-drempel. */
  force?: boolean;
  /** Bootstrap: dit kantoor meteen als geselecteerd kantoor bewaren. */
  selectOffice?: boolean;
}

export type CentralOfficeListResult =
  | { ok: true; offices: CentralOfficeSummary[] }
  | { ok: false; kind: CentralMasterErrorKind; message: string };

const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

export function describeMasterError(kind: CentralMasterErrorKind, detail?: string): string {
  switch (kind) {
    case "not-found":
      return "Voor dit kantoor is nog geen centrale masterdata gepubliceerd.";
    case "invalid":
      return `Centrale masterdata onbruikbaar${detail ? `: ${detail}` : "."}`;
    case "unavailable":
      return "Centrale masterdata niet bereikbaar — de lokale data blijft beschikbaar.";
  }
}

/**
 * Centrale master → lokale IndexedDB.
 *
 * Eisen (user):
 *  - De centrale master is autoritatief voor ACTUELE masterdata; de historiek is
 *    autoritatief voor tellingen. Dit raakt dus nooit tellingen, sessies of
 *    historiek (zie `domain/centralMasterPlan.ts`).
 *  - Tijdens een ACTIEVE telling wordt de master wel opgehaald en gevalideerd,
 *    maar NIET toegepast: de bevroren scope van die telling (artikelen,
 *    locaties) én de live-gelezen koppelingen/stamvelden blijven exact zoals ze
 *    waren. Nieuwe masterdata geldt pas voor de volgende telling — de uitgestelde
 *    revision staat in `pendingRevision` en wordt automatisch toegepast bij de
 *    eerstvolgende sync nadat de telling afgerond of geannuleerd is.
 *  - FALEN BLOKKEERT NOOIT: `syncOffice` gooit nooit; elke fout wordt een
 *    interne status (`lastError`), en lokale data blijft ongewijzigd.
 */
export class CentralMasterSyncService {
  private readonly repository: CountingRepository;
  private readonly source: CentralMasterSource;
  private readonly now: () => Date;
  private readonly minIntervalMs: number;
  private readonly inFlight = new Map<string, Promise<CentralMasterSyncResult>>();

  constructor(
    repository: CountingRepository,
    source: CentralMasterSource,
    options: { now?: () => Date; minIntervalMs?: number } = {},
  ) {
    this.repository = repository;
    this.source = source;
    this.now = options.now ?? (() => new Date());
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  }

  get sourceLabel(): string {
    return this.source.label;
  }

  getStatus(officeId: string): Promise<CentralMasterStatus | undefined> {
    return this.repository.getCentralMasterStatus(officeId);
  }

  /** Kantorenlijst voor het bootstrap-scherm. Gooit nooit. */
  async listOffices(): Promise<CentralOfficeListResult> {
    try {
      return { ok: true, offices: await this.source.fetchOfficeIndex() };
    } catch (error) {
      const kind = error instanceof CentralMasterError ? error.kind : "unavailable";
      return { ok: false, kind, message: describeMasterError(kind, error instanceof Error ? error.message : undefined) };
    }
  }

  /** Veilig om fire-and-forget aan te roepen: gooit nooit, dedupliceert gelijktijdige aanroepen per kantoor. */
  syncOffice(officeId: string, options: CentralMasterSyncOptions = {}): Promise<CentralMasterSyncResult> {
    const running = this.inFlight.get(officeId);
    if (running) return running;
    const promise = this.runSync(officeId, options)
      .catch((error: unknown) => this.recordUnexpectedFailure(officeId, error))
      .finally(() => {
        this.inFlight.delete(officeId);
      });
    this.inFlight.set(officeId, promise);
    return promise;
  }

  private async runSync(officeId: string, options: CentralMasterSyncOptions): Promise<CentralMasterSyncResult> {
    const previous = await this.repository.getCentralMasterStatus(officeId);
    const nowIso = this.now().toISOString();

    if (
      !options.force &&
      isCentrallyManaged(previous) &&
      previous?.lastSuccessAt &&
      previous.lastError === null &&
      previous.pendingRevision === null &&
      previous.revision !== null
    ) {
      const age = this.now().getTime() - new Date(previous.lastSuccessAt).getTime();
      if (age >= 0 && age < this.minIntervalMs) return { outcome: "skipped-recent", message: null };
    }

    const knownRevision = isCentrallyManaged(previous) ? (previous?.revision ?? null) : null;
    let result;
    try {
      result = await this.source.fetchOfficeMaster(officeId, { knownRevision });
    } catch (error) {
      return this.recordFetchFailure(officeId, previous, nowIso, error);
    }

    if (result.kind === "unchanged") {
      if (previous) {
        await this.safeSaveStatus({
          ...previous,
          lastAttemptAt: nowIso,
          lastSuccessAt: nowIso,
          lastError: null,
          pendingRevision: null,
        });
      }
      return { outcome: "unchanged", message: null };
    }

    const master = result.file;
    const office = await this.repository.getOffice(officeId);

    // Actieve telling → nooit toepassen. Enkel noteren dat er iets wacht.
    const activeSession = office ? await this.repository.getActiveSession(officeId) : undefined;
    if (activeSession) {
      const base = previous ?? emptyStatus(officeId);
      await this.safeSaveStatus({
        ...base,
        lastAttemptAt: nowIso,
        lastSuccessAt: nowIso,
        lastError: null,
        pendingRevision: master.revision,
      });
      return { outcome: "deferred", message: null };
    }

    const [articles, allArticles, assignments, categories] = await Promise.all([
      this.repository.getArticles(officeId),
      this.repository.getAllArticles(),
      this.repository.getArticleLocationAssignments(officeId),
      this.repository.getProductCategories(),
    ]);
    const plan = planCentralMasterApply({
      master,
      local: { office, articles, allArticles, assignments, categories },
      previousStatus: previous,
      now: nowIso,
      selectOffice: options.selectOffice ?? false,
    });
    await this.repository.applyCentralMaster(plan);
    return { outcome: "applied", message: null, summary: plan.summary };
  }

  private async recordFetchFailure(
    officeId: string,
    previous: CentralMasterStatus | undefined,
    nowIso: string,
    error: unknown,
  ): Promise<CentralMasterSyncResult> {
    const kind = error instanceof CentralMasterError ? error.kind : "unavailable";
    const message = describeMasterError(kind, error instanceof Error ? error.message : undefined);
    // Enkel een foutenregistratie bijhouden als dit kantoor lokaal bestaat (of al een status had) —
    // een mislukte bootstrap mag geen wees-rij achterlaten.
    if (previous || (await this.repository.getOffice(officeId))) {
      const base = previous ?? emptyStatus(officeId);
      await this.safeSaveStatus({
        ...base,
        lastAttemptAt: nowIso,
        lastSuccessAt: kind === "not-found" ? nowIso : base.lastSuccessAt,
        lastError: message,
      });
    }
    return { outcome: kind === "not-found" ? "not-found" : "failed", message, kind };
  }

  private async recordUnexpectedFailure(officeId: string, error: unknown): Promise<CentralMasterSyncResult> {
    const message = `Synchronisatie van masterdata mislukt: ${error instanceof Error ? error.message : "onbekende fout"}`;
    try {
      const previous = await this.repository.getCentralMasterStatus(officeId);
      if (previous || (await this.repository.getOffice(officeId))) {
        await this.safeSaveStatus({
          ...(previous ?? emptyStatus(officeId)),
          lastAttemptAt: this.now().toISOString(),
          lastError: message,
        });
      }
    } catch {
      // Zelfs het wegschrijven van de status mag de app nooit blokkeren.
    }
    return { outcome: "failed", message, kind: "unavailable" };
  }

  private async safeSaveStatus(status: CentralMasterStatus): Promise<void> {
    try {
      await this.repository.saveCentralMasterStatus(status);
    } catch {
      // Status is puur informatief — nooit een reden om de sync te laten falen.
    }
  }
}

function emptyStatus(officeId: string): CentralMasterStatus {
  return {
    officeId,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    revision: null,
    generatedAt: null,
    appliedAt: null,
    pendingRevision: null,
    articleIds: [],
    locationIds: [],
    categoryIds: [],
    assignmentIds: [],
  };
}
