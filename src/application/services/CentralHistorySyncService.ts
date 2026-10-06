import {
  buildHistoricalOnlyArticle,
  centralSessionIdsOf,
  isCentralSessionIn,
  type CentralHistoryFile,
  type CentralHistoryStatus,
} from "../../domain/centralHistoryFile";
import { historyEntryKey, mergeHistoryEntries } from "../../domain/stockSnapshot";
import type { Article, CountSession } from "../../domain/types";
import { CentralHistoryError, type CentralHistorySource } from "../ports/CentralHistorySource";
import type { CountingRepository } from "../ports/CountingRepository";
import { reconstructMissingSessionsFromHistory } from "./historyReconstruction";

export type CentralHistorySyncOutcome =
  /** Centrale historiek opgehaald en additief samengevoegd (ook als er niets nieuw was). */
  | "synced"
  /** Laatste succesvolle sync was net (zie `minIntervalMs`) — niets geprobeerd. */
  | "skipped-recent"
  /** Het kantoor bestaat lokaal (nog) niet — niets geprobeerd. */
  | "no-office"
  /** Poging mislukt; lokale data ongewijzigd, de app werkt gewoon door. */
  | "failed";

export interface CentralHistorySyncResult {
  outcome: CentralHistorySyncOutcome;
  /** Aantal sessies dat deze sync lokaal NIEUW aanmaakte. */
  addedSessionCount: number;
  /** Discrete melding voor de UI, of `null` wanneer alles in orde is. */
  message: string | null;
}

export interface CentralHistorySyncOptions {
  /** Negeer de "recent gesynchroniseerd"-drempel (handmatige knop). */
  force?: boolean;
}

const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const SOURCE_FILE_NAME = "Hersteld uit centrale historiek";

/**
 * Centrale read-only historiek → lokale IndexedDB.
 *
 * Eisen (user, 8 punten + 3 aanpassingen):
 *  - ADDITIEF/IDEMPOTENT: nooit een lokale sessie verwijderen omdat ze niet
 *    centraal staat; nooit lokale data overschrijven (bij een botsing op
 *    (sessienaam, artikel) WINT de lokale regel); geen dubbels (stabiele
 *    `sourceSessionId`, zie `historyReconstruction.ts`).
 *  - "AFWEZIG ≠ VERWIJDERD": `deletedSessionIds` (tombstones) wordt wel
 *    geparsed (schema is er klaar voor) maar in v1 bewust NIET toegepast.
 *  - FALEN BLOKKEERT NOOIT: `syncOffice` gooit nooit; elke fout wordt een
 *    discrete melding in de status.
 *  - Centrale sessies zijn in v1 read-only qua verwijdering in de gewone app
 *    (`CountSessionService#deleteSession` raadpleegt `isCentralSession`).
 *  - Offline blijft alles werken: de data staat na één geslaagde sync gewoon
 *    lokaal; een mislukte poging verandert niets aan die lokale data.
 */
export class CentralHistorySyncService {
  private readonly repository: CountingRepository;
  private readonly source: CentralHistorySource;
  private readonly now: () => Date;
  private readonly minIntervalMs: number;
  private readonly inFlight = new Map<string, Promise<CentralHistorySyncResult>>();

  constructor(
    repository: CountingRepository,
    source: CentralHistorySource,
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

  getStatus(officeId: string): Promise<CentralHistoryStatus | undefined> {
    return this.repository.getCentralHistoryStatus(officeId);
  }

  /**
   * Is deze lokale sessie ook centraal bekend (op id, of — zwakker — op
   * snapshotnaam)? Zo ja: read-only qua verwijdering in de gewone app.
   */
  async isCentralSession(session: Pick<CountSession, "id" | "officeId" | "type" | "completedAt" | "startedAt">): Promise<boolean> {
    const status = await this.repository.getCentralHistoryStatus(session.officeId);
    return isCentralSessionIn(status, session);
  }

  /** Veilig om fire-and-forget aan te roepen: gooit nooit, dedupliceert gelijktijdige aanroepen per kantoor. */
  syncOffice(officeId: string, options: CentralHistorySyncOptions = {}): Promise<CentralHistorySyncResult> {
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

  private async runSync(officeId: string, options: CentralHistorySyncOptions): Promise<CentralHistorySyncResult> {
    const office = await this.repository.getOffice(officeId);
    if (!office) return { outcome: "no-office", addedSessionCount: 0, message: null };

    const previous = await this.repository.getCentralHistoryStatus(officeId);
    const nowIso = this.now().toISOString();

    if (!options.force && previous?.lastSuccessAt && previous.lastError === null) {
      const age = this.now().getTime() - new Date(previous.lastSuccessAt).getTime();
      if (age >= 0 && age < this.minIntervalMs) {
        return { outcome: "skipped-recent", addedSessionCount: 0, message: null };
      }
    }

    let file: CentralHistoryFile;
    try {
      file = await this.source.fetchOfficeHistory(officeId);
    } catch (error) {
      return this.recordFetchFailure(officeId, previous, nowIso, error);
    }

    const added = await this.applyAdditively(officeId, file, previous, nowIso);
    return { outcome: "synced", addedSessionCount: added, message: null };
  }

  private async recordFetchFailure(
    officeId: string,
    previous: CentralHistoryStatus | undefined,
    nowIso: string,
    error: unknown,
  ): Promise<CentralHistorySyncResult> {
    const kind = error instanceof CentralHistoryError ? error.kind : "unavailable";
    const base = previous ?? emptyStatus(officeId);
    if (kind === "not-found") {
      // Voor dit kantoor staat er (nog) niets centraal — geen fout, wel een
      // discrete melding. Bestaande `centralSessionIds` blijven ongemoeid.
      const message = "Voor dit kantoor is nog geen centrale historiek gepubliceerd.";
      await this.safeSaveStatus({ ...base, lastAttemptAt: nowIso, lastSuccessAt: nowIso, lastError: message });
      return { outcome: "synced", addedSessionCount: 0, message };
    }
    const message =
      kind === "invalid"
        ? `Centrale historiek onbruikbaar: ${error instanceof Error ? error.message : "onbekende fout"}`
        : "Centrale historiek niet bereikbaar — de lokale data blijft beschikbaar.";
    await this.safeSaveStatus({ ...base, lastAttemptAt: nowIso, lastError: message });
    return { outcome: "failed", addedSessionCount: 0, message };
  }

  private async recordUnexpectedFailure(officeId: string, error: unknown): Promise<CentralHistorySyncResult> {
    const message = `Synchronisatie mislukt: ${error instanceof Error ? error.message : "onbekende fout"}`;
    try {
      const previous = await this.repository.getCentralHistoryStatus(officeId);
      await this.safeSaveStatus({
        ...(previous ?? emptyStatus(officeId)),
        lastAttemptAt: this.now().toISOString(),
        lastError: message,
      });
    } catch {
      // Zelfs het wegschrijven van de status mag de app nooit blokkeren.
    }
    return { outcome: "failed", addedSessionCount: 0, message };
  }

  private async safeSaveStatus(status: CentralHistoryStatus): Promise<void> {
    try {
      await this.repository.saveCentralHistoryStatus(status);
    } catch {
      // Status is puur informatief — nooit een reden om de sync te laten falen.
    }
  }

  private async applyAdditively(
    officeId: string,
    file: CentralHistoryFile,
    previous: CentralHistoryStatus | undefined,
    nowIso: string,
  ): Promise<number> {
    const central = file.entries;

    // 1. Historiek: LOKAAL WINT bij een botsing op (sessienaam, artikel) —
    //    `mergeHistoryEntries(existing, incoming)` laat `incoming` winnen, dus
    //    de centrale regels gaan eerst en de lokale erna. Er wordt enkel
    //    geschreven als er écht iets nieuws binnenkomt.
    const local = await this.repository.getStockHistoryEntries(officeId);
    const localKeys = new Set(local.map(historyEntryKey));
    const hasNewEntries = central.some((entry) => !localKeys.has(historyEntryKey(entry)));
    const merged = hasNewEntries ? mergeHistoryEntries(central, local) : local;
    if (hasNewEntries) {
      await this.repository.saveStockHistoryEntries(officeId, merged);
    }

    // 2. Artikelen die dit toestel niet kent (bv. intussen uit het master-
    //    bestand verdwenen): historisch/inactief record, nooit een bestaand
    //    artikel overschrijven. Nodig voor Analyse/Vergelijken-snapshots.
    const knownArticles = await this.repository.getArticles(officeId);
    const knownIds = new Set(knownArticles.map((a) => a.id));
    const newArticles = new Map<string, Article>();
    for (const entry of central) {
      if (knownIds.has(entry.articleId) || newArticles.has(entry.articleId)) continue;
      newArticles.set(entry.articleId, buildHistoricalOnlyArticle(entry, officeId));
    }
    if (newArticles.size > 0) {
      await this.repository.saveArticles(Array.from(newArticles.values()));
    }

    // 3. Echte (niet-legacy) centrale sessies die lokaal nog ontbreken worden
    //    gereconstrueerd (gedeelde logica met de Excel-import). Enkel sessies
    //    die ook in het centrale bestand staan — nooit lokale restanten.
    const centralSessionNames = new Set(
      central.filter((e) => e.source !== "LEGACY_IMPORT").map((e) => e.sessionName),
    );
    const toReconstruct = merged.filter((e) => centralSessionNames.has(e.sessionName));
    const created = await reconstructMissingSessionsFromHistory(
      this.repository,
      officeId,
      toReconstruct,
      SOURCE_FILE_NAME,
    );

    // 4. `file.deletedSessionIds` (tombstones) bewust NIET toegepast in v1.

    const status: CentralHistoryStatus = {
      officeId,
      lastAttemptAt: nowIso,
      lastSuccessAt: nowIso,
      lastError: null,
      lastGeneratedAt: file.generatedAt,
      lastAddedSessionCount: created.length,
      centralSessionIds: union(previous?.centralSessionIds, centralSessionIdsOf(central), created.map((s) => s.id)),
      centralSessionNames: union(previous?.centralSessionNames, Array.from(centralSessionNames)),
    };
    await this.repository.saveCentralHistoryStatus(status);
    return created.length;
  }
}

function emptyStatus(officeId: string): CentralHistoryStatus {
  return {
    officeId,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastGeneratedAt: null,
    lastAddedSessionCount: 0,
    centralSessionIds: [],
    centralSessionNames: [],
  };
}

function union(...lists: Array<readonly string[] | undefined>): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const item of list ?? []) out.add(item);
  return Array.from(out);
}
