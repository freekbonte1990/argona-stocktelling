import { isCentrallyManaged } from "../../domain/centralMasterFile";
import { applyDerivedPreviousCounts, derivePreviousCountsFromHistory } from "../../domain/previousCount";
import type { CountingRepository } from "../ports/CountingRepository";
import type { CentralHistorySyncResult, CentralHistorySyncService } from "./CentralHistorySyncService";
import type { CentralMasterSyncResult, CentralMasterSyncService, CentralOfficeListResult } from "./CentralMasterSyncService";

export interface CentralBootstrapResult {
  /** `true` = het kantoor staat nu lokaal (master toegepast); de app kan normaal openen. */
  ok: boolean;
  /** Begrijpelijke melding voor het bootstrap-scherm wanneer `ok` onwaar is. */
  message: string | null;
  master: CentralMasterSyncResult;
  /** Ontbreekt als de master niet kon worden toegepast. Een mislukte historiek maakt `ok` NIET onwaar. */
  history: CentralHistorySyncResult | null;
}

export interface CentralDataSyncResult {
  master: CentralMasterSyncResult;
  history: CentralHistorySyncResult;
}

/**
 * Orkestreert de volledige centrale sync van één kantoor, in een vaste volgorde:
 *
 *   1. master  (autoritatief voor actuele stamdata)
 *   2. historiek (autoritatief voor tellingen) — via de ONGEWIJZIGDE
 *      `CentralHistorySyncService`
 *   3. "Vorige telling" afleiden uit de historiek (nooit uit de master)
 *
 * Een mislukte master blokkeert de historiek niet en omgekeerd; alles is
 * best-effort en gooit nooit. Geen UI-kennis, geen bron-kennis: beide bronnen
 * zijn ports (vandaag HTTP, straks eBuddy).
 */
export class CentralDataSyncService {
  private readonly repository: CountingRepository;
  private readonly masterSync: CentralMasterSyncService;
  private readonly historySync: CentralHistorySyncService;

  constructor(
    repository: CountingRepository,
    masterSync: CentralMasterSyncService,
    historySync: CentralHistorySyncService,
  ) {
    this.repository = repository;
    this.masterSync = masterSync;
    this.historySync = historySync;
  }

  listOffices(): Promise<CentralOfficeListResult> {
    return this.masterSync.listOffices();
  }

  /**
   * Eerste start voor een kantoor: master ophalen → valideren → lokaal opslaan
   * (één transactie) → historiek ophalen → klaar. Mislukt de master, dan wordt
   * er NIETS lokaal opgeslagen. Mislukt enkel de historiek, dan is de app toch
   * bruikbaar (de master volstaat om te tellen) en probeert een latere sync het opnieuw.
   */
  async bootstrapOffice(officeId: string): Promise<CentralBootstrapResult> {
    const master = await this.masterSync.syncOffice(officeId, { force: true, selectOffice: true });
    // "deferred": het kantoor staat al lokaal en er loopt een telling — de nieuwe master wacht tot die afgerond is.
    if (master.outcome !== "applied" && master.outcome !== "unchanged" && master.outcome !== "deferred") {
      return { ok: false, message: master.message, master, history: null };
    }
    const history = await this.historySync.syncOffice(officeId, { force: true });
    await this.deriveAndSavePreviousCounts(officeId);
    return { ok: true, message: null, master, history };
  }

  /** Achtergrond-sync (fire-and-forget): gooit nooit. */
  async syncOffice(officeId: string, options: { force?: boolean } = {}): Promise<CentralDataSyncResult> {
    const master = await this.masterSync.syncOffice(officeId, { force: options.force });
    const history = await this.historySync.syncOffice(officeId, { force: options.force });
    try {
      await this.deriveAndSavePreviousCounts(officeId);
    } catch {
      // Afleiding is best-effort; nooit een reden om de app te blokkeren.
    }
    return { master, history };
  }

  /**
   * "Vorige telling" uitsluitend uit de historiek (zie `domain/previousCount.ts`).
   * Enkel voor een centraal beheerd kantoor, en NIET tijdens een actieve telling
   * (de waarden die de lopende telling toont blijven dan onaangeroerd).
   */
  async deriveAndSavePreviousCounts(officeId: string): Promise<number> {
    const status = await this.repository.getCentralMasterStatus(officeId);
    if (!isCentrallyManaged(status)) return 0;
    if (await this.repository.getActiveSession(officeId)) return 0;
    const [history, articles] = await Promise.all([
      this.repository.getStockHistoryEntries(officeId),
      this.repository.getArticles(officeId),
    ]);
    const changed = applyDerivedPreviousCounts(articles, derivePreviousCountsFromHistory(history));
    if (changed.length > 0) await this.repository.saveArticles(changed);
    return changed.length;
  }
}
