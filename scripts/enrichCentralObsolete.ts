import { createHash } from "node:crypto";
import { initialClassificationFromStatus } from "../src/domain/stockClassification";
import { parseCentralHistoryFile, serializeCentralHistoryFile, type CentralHistoryFile } from "../src/domain/centralHistoryFile";
import { parseCentralMasterFile, type CentralMasterFile } from "../src/domain/centralMasterFile";
import { planCentralMasterApply } from "../src/domain/centralMasterPlan";
import { buildLegacyImportPlan, type LegacyStockRow } from "../src/domain/legacyImport";
import { REQUIRED_LEGACY_PERIODS } from "../src/domain/legacyPeriods";
import { historyEntryKey, type StockHistoryEntry } from "../src/domain/stockSnapshot";
import { computeMasterRevision, serializeCentralMasterFile } from "./centralMasterPublication";

/**
 * Eenmalige, reproduceerbare correctie van de reeds gepubliceerde centrale
 * bestanden (geen generieke migratie):
 *  1. MASTER: `stockClassification` = expliciete obsolete-bronstatus (OBSOLETE*) als
 *     initiële waarde; al het andere blijft zoals het was. Nieuwe revision.
 *  2. HISTORIEK legacy: voegt ENKEL `stockClassification` toe uit de expliciete
 *     "OBSOLETE?"-bronvlag (JA* -> OBSOLETE, NEE/NEEN -> ACTIVE, rest onbekend).
 *     Hoeveelheden/kostprijzen worden gecontroleerd en nooit gewijzigd.
 *  3. HISTORIEK app-sessie: hernoemt de ene telling van 06/10/2026 van
 *     "2026-Q4 Kwartaal" naar "2026-Q3 Kwartaal" en zet de classificatie volgens de
 *     expliciete bronstatus. Sessie-ID, datum, hoeveelheden, kostprijzen blijven.
 */
export interface EnrichInput {
  officeId: string;
  master: CentralMasterFile;
  history: CentralHistoryFile;
  legacyRows: LegacyStockRow[];
  generatedAt: string;
}

export interface EnrichReport {
  officeId: string;
  masterObsoleteBefore: number;
  masterObsoleteAfter: number;
  legacyPerPeriod: Record<string, { entries: number; obsolete: number; active: number; unknown: number }>;
  legacyUnmatchedEntries: number;
  legacyValueMismatches: number;
  renamedSession: { id: string | null; from: string; to: string; entries: number; obsolete: number; active: number; unknown: number } | null;
}

export const Q3_FROM = "2026-Q4 Kwartaal";
export const Q3_TO = "2026-Q3 Kwartaal";
/** Per kantoor de datum van de (centraal) foutief als Q4 benoemde kwartaaltelling. */
export const Q3_DATE_BY_OFFICE: Record<string, string> = { lokeren: "2026-10-06", damme: "2026-10-01" };

export function enrichCentralObsolete(input: EnrichInput): { master: CentralMasterFile; history: CentralHistoryFile; report: EnrichReport } {
  const count = (m: CentralMasterFile) => m.articles.filter((a) => a.stockClassification === "OBSOLETE").length;
  const report: EnrichReport = {
    officeId: input.officeId,
    masterObsoleteBefore: count(input.master),
    masterObsoleteAfter: 0,
    legacyPerPeriod: {},
    legacyUnmatchedEntries: 0,
    legacyValueMismatches: 0,
    renamedSession: null,
  };

  // 1. master
  const articles = input.master.articles.map((a) => {
    const explicit = initialClassificationFromStatus(a.rawStatus);
    return explicit ? { ...a, stockClassification: explicit } : a;
  });
  const content = { ...input.master, articles };
  const master: CentralMasterFile = {
    ...content,
    generatedAt: input.generatedAt,
    revision: computeMasterRevision(content),
  };
  report.masterObsoleteAfter = count(master);
  const masterStatusByArticleId = new Map(master.articles.map((a) => [`${input.officeId}:${a.articleNumber}`, a.rawStatus]));

  // 2. legacy
  const local = planCentralMasterApply({
    master,
    local: { office: undefined, articles: [], allArticles: [], assignments: [], categories: [] },
    previousStatus: undefined,
    now: input.generatedAt,
  }).articles;
  const periods = new Map(REQUIRED_LEGACY_PERIODS.map((p) => [p.key, { label: p.label, isoDate: p.isoDate }]));
  const plan = buildLegacyImportPlan(input.legacyRows, input.officeId, periods, local);
  const planByKey = new Map<string, StockHistoryEntry>(plan.historyEntries.map((e) => [historyEntryKey(e), e]));

  // Terugval voor rijen die in de historiek op een lokaal (TMP-)artikel resolveerden dat niet in
  // de master staat: enkel een ondubbelzinnige match op periode + omschrijving + hoeveelheid + kostprijs.
  const fuzzyKey = (e: StockHistoryEntry) => `${e.sessionName}|${e.description}|${e.totalCount}|${e.costPrice}`;
  const fuzzy = new Map<string, StockHistoryEntry[]>();
  for (const e of plan.historyEntries) fuzzy.set(fuzzyKey(e), [...(fuzzy.get(fuzzyKey(e)) ?? []), e]);

  const entries = input.history.entries.map((entry): StockHistoryEntry => {
    if (entry.source === "LEGACY_IMPORT") {
      const bucket = (report.legacyPerPeriod[entry.sessionName] ??= { entries: 0, obsolete: 0, active: 0, unknown: 0 });
      bucket.entries += 1;
      let src = planByKey.get(historyEntryKey(entry));
      if (!src) {
        const candidates = fuzzy.get(fuzzyKey(entry)) ?? [];
        const distinct = new Set(candidates.map((c) => c.stockClassification ?? "?"));
        if (candidates.length > 0 && distinct.size === 1) src = candidates[0];
      }
      if (!src) {
        report.legacyUnmatchedEntries += 1;
        bucket.unknown += 1;
        return entry;
      }
      if (src.totalCount !== entry.totalCount || src.costPrice !== entry.costPrice) {
        report.legacyValueMismatches += 1;
        bucket.unknown += 1;
        return entry; // nooit raken als de waarden niet exact overeenkomen
      }
      if (src.stockClassification === "OBSOLETE") bucket.obsolete += 1;
      else if (src.stockClassification === "ACTIVE") bucket.active += 1;
      else bucket.unknown += 1;
      return src.stockClassification ? { ...entry, stockClassification: src.stockClassification } : entry;
    }
    return entry;
  });

  // 3. de ene app-sessie van 06/10/2026
  const q3Date = Q3_DATE_BY_OFFICE[input.officeId] ?? "";
  const target = entries.filter((e) => e.source !== "LEGACY_IMPORT" && e.sessionName === Q3_FROM && e.countDate === q3Date);
  const clash = entries.some((e) => e.sessionName === Q3_TO);
  if (clash) throw new Error(`"${Q3_TO}" bestaat al in de historiek van ${input.officeId} — niets gewijzigd.`);
  let finalEntries = entries;
  if (target.length > 0) {
    const ids = new Set(target.map((e) => e.sourceSessionId ?? null));
    const r = { id: [...ids][0] ?? null, from: Q3_FROM, to: Q3_TO, entries: target.length, obsolete: 0, active: 0, unknown: 0 };
    finalEntries = entries.map((e) => {
      if (!(e.source !== "LEGACY_IMPORT" && e.sessionName === Q3_FROM && e.countDate === q3Date)) return e;
      const explicit = initialClassificationFromStatus(masterStatusByArticleId.get(e.articleId));
      const known = masterStatusByArticleId.has(e.articleId);
      const stockClassification = explicit ?? (known ? ("ACTIVE" as const) : undefined);
      if (stockClassification === "OBSOLETE") r.obsolete += 1;
      else if (stockClassification === "ACTIVE") r.active += 1;
      else r.unknown += 1;
      return { ...e, sessionName: Q3_TO, ...(stockClassification ? { stockClassification } : {}) };
    });
    report.renamedSession = r;
  }

  const history: CentralHistoryFile = { ...input.history, generatedAt: input.generatedAt, entries: finalEntries };
  return { master, history, report };
}

export { parseCentralHistoryFile, parseCentralMasterFile, serializeCentralHistoryFile, serializeCentralMasterFile };
void createHash;
