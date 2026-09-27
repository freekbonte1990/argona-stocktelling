import { buildLegacyImportPlan, type LegacyImportPreview, type LegacyStockRow } from "../../domain/legacyImport";
import { LEGACY_PERIOD_BY_KEY } from "../../domain/legacyPeriods";
import { historyEntryKey, mergeHistoryEntries } from "../../domain/stockSnapshot";
import type { CountingRepository } from "../ports/CountingRepository";

/**
 * Sprint 3.3 §3 (legacy historische stockimport): dunne applicatielaag boven
 * `domain/legacyImport.ts#buildLegacyImportPlan` — orkestreert enkel het
 * OPHALEN van het huidige mastermodel (nodig als matching-context) en het
 * BEWAREN van het resulterende plan, zonder zelf enige matching-/
 * berekeningslogica te bevatten (die blijft volledig puur in de domeinlaag).
 *
 * Bewust los van `ImportService` (die een volledig kantoor + huidig
 * assortiment importeert): een legacy-import is altijd AANVULLEND op een
 * reeds bestaand kantoor (spec §3: "oude artikelen blijven historisch
 * zichtbaar, maar worden niet actief in nieuwe tellingen") en raakt nooit de
 * levende artikelstam van bestaande artikelen, enkel:
 *   - nieuwe, historisch/inactieve artikelen voor rijen zonder huidige match
 *     (`plan.newArticles`, via de bestaande upsert-semantiek van
 *     `saveArticles` — botst nooit met een bestaand ID, zie
 *     `buildLegacyOnlyArticle`);
 *   - de machinevriendelijke HISTORIE-log, samengevoegd via de reeds
 *     bestaande `mergeHistoryEntries` (dedup op sessienaam+artikel-ID) —
 *     exact hetzelfde precedent als `ImportService`/`ExportService` voor het
 *     rollend stockarchief.
 *
 * Idempotent door constructie: `buildLegacyImportPlan` levert bij dezelfde
 * brondata altijd dezelfde artikel-ID's/HISTORIE-sleutels op, dus een
 * herhaalde `commit` van dezelfde rijen overschrijft gewoon dezelfde records
 * opnieuw (geen duplicaten) — zolang de aanroeper (UI) voor élke aanroep de
 * volledige rijenset van het bronbestand doorgeeft, niet een gedeeltelijke
 * subset.
 */
export class LegacyImportService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  /**
   * Enkel lezen/berekenen — bewaart niets. Voor de preview/rapport-stap
   * vóór commit (spec §3: "preview/report before applying").
   */
  async preview(officeId: string, rows: LegacyStockRow[]): Promise<LegacyImportPreview> {
    const currentArticles = await this.repository.getArticles(officeId);
    return buildLegacyImportPlan(rows, officeId, LEGACY_PERIOD_BY_KEY, currentArticles).preview;
  }

  /**
   * Berekent het plan opnieuw (tegen de op dit moment werkelijk bewaarde
   * artikelstam — nooit de eerder getoonde preview blindelings hergebruiken,
   * die kan intussen verouderd zijn) en bewaart het.
   */
  async commit(
    officeId: string,
    rows: LegacyStockRow[],
  ): Promise<{ preview: LegacyImportPreview; newArticleCount: number; historyEntryCount: number }> {
    const currentArticles = await this.repository.getArticles(officeId);
    const plan = buildLegacyImportPlan(rows, officeId, LEGACY_PERIOD_BY_KEY, currentArticles);

    if (plan.newArticles.length > 0) {
      await this.repository.saveArticles(plan.newArticles);
    }

    const existingHistory = await this.repository.getStockHistoryEntries(officeId);
    const mergedHistory = mergeHistoryEntries(existingHistory, plan.historyEntries);
    await this.repository.saveStockHistoryEntries(officeId, mergedHistory);

    // `plan.historyEntries.length` is VÓÓR deduplicatie (zie
    // `LegacyImportPlan.historyEntries`'s eigen documentatie) — een bron met
    // dubbele (periode, artikel)-rijen (`plan.preview.duplicateRowCount`)
    // bewaart er dus effectief minder dan er rijen waren. Hier het WERKELIJK
    // bewaarde aantal voor DEZE batch tellen (nooit het eerder bewaarde
    // `existingHistory` meetellen), zodat de UI nooit een groter aantal
    // "bewaard" claimt dan er werkelijk in de repository terechtkwam.
    const distinctIncomingKeys = new Set(plan.historyEntries.map((entry) => historyEntryKey(entry)));

    return {
      preview: plan.preview,
      newArticleCount: plan.newArticles.length,
      historyEntryCount: distinctIncomingKeys.size,
    };
  }
}
