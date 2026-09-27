import type { SessionReviewSummary } from "../../domain/review";
import type { StockHistoryEntry, StockSnapshot } from "../../domain/stockSnapshot";
import type { Article, ArticleLocationAssignment, CountSession, Office, ProductCategory } from "../../domain/types";
import type { HistoricalSheetSnapshot } from "./StockSource";

/**
 * Alles wat een exporter nodig heeft om de resultaten van een AFGEWERKTE (of
 * lopende) telling weg te schrijven. Bewust een plat data-object: de
 * resultaatberekening (`SessionReviewSummary`, `StockSnapshot`,
 * `StockHistoryEntry[]`) gebeurt altijd vooraf in `domain/` /
 * `ExportService`, nooit in de exporter zelf (spec — "schrijf geen
 * businesslogica rechtstreeks in de Excel-adapter").
 */
export interface StockResultExportInput {
  office: Office;
  session: CountSession;
  review: SessionReviewSummary;
  /** Alle artikelen van het kantoor (niet enkel de sessiescope) — nodig om ARTIKEL/CONFIG volledig te reconstrueren. */
  allArticles: Article[];
  /**
   * Alle locatiekoppelingen van het kantoor (v0.2.1 correctieronde §3C) —
   * nodig om in NIEUWE_ARTIKELEN de huidige locatie(s) van een tijdelijk
   * artikel te tonen.
   */
  assignments: ArticleLocationAssignment[];
  /**
   * Sprint 3.2 §14 (Excel portability): de VOLLEDIGE, bedrijfsbrede/globale
   * Productgamma-lijst (niet enkel de categorieën die dit kantoor gebruikt)
   * — wordt ongewijzigd als sheet PRODUCTGAMMAS teruggeschreven, zodat een
   * export vanuit eender welk kantoor altijd de volledige, gedeelde lijst
   * meeneemt (spec: "exact dezelfde category IDs/names/order/active-states").
   */
  categories: ProductCategory[];
  /**
   * Rollend stockarchief (nieuw): de volledige voorraad-snapshot van DEZE
   * sessie, waaruit de exporter het nieuwe, benoemde tellingtabblad opbouwt
   * (bv. "2026-09 Maand").
   */
  snapshot: StockSnapshot;
  /**
   * Reeds gekende, ANDERE historische tellingtabs (geïmporteerd en/of eerder
   * door een vorige sessie bevroren) — worden ONGEWIJZIGD als aparte tabs
   * teruggeschreven (spec: "een bestaand historisch tellingtabblad mag nooit
   * gewijzigd of overschreven worden"). Bevat NOOIT een tab met dezelfde naam
   * als `snapshot.sessionName` — die naamconflict-check gebeurt vooraf in
   * `ExportService`.
   */
  historicalSheets: HistoricalSheetSnapshot[];
  /**
   * Volledige, reeds samengevoegde/gededupliceerde HISTORIE-log (bestaand +
   * nieuw voor deze sessie) — wordt vers als HISTORIE-sheet weggeschreven.
   */
  historyEntries: StockHistoryEntry[];
  /**
   * Indien deze sessie al eerder (in een vorige export) bevroren werd: de
   * exact daarbij gegenereerde ruwe rijen, te HERGEBRUIKEN in plaats van
   * herberekend — anders zou een herhaalde export van dezelfde, al
   * afgeronde sessie een ander resultaat kunnen geven zodra `allArticles`
   * intussen door een LATERE sessie bijgewerkt is (spec: "oude snapshots
   * blijven ... nooit hun celdata wijzigen").
   */
  frozenSnapshotRows?: unknown[][];
}

export interface ExportedFile {
  fileName: string;
  /** Ruwe bestandsinhoud (.xlsx-bytes). */
  data: ArrayBuffer;
  /**
   * De ruwe rijen van het NIEUW gegenereerde tellingtabblad voor deze sessie
   * (`input.snapshot.sessionName`) — enkel aanwezig wanneer dit tabblad niet
   * al via `frozenSnapshotRows` hergebruikt werd. `ExportService` bewaart dit
   * zodat een volgende export dit tabblad nooit meer herberekent.
   */
  newHistoricalSheet?: HistoricalSheetSnapshot;
}

/**
 * Port voor het wegschrijven van tellingsresultaten naar een extern formaat.
 * Vandaag geïmplementeerd door `ExcelStockResultExporter`
 * (adapters/excel/ExcelStockResultExporter.ts). Een latere
 * `EBuddyStockResultExporter` kan dezelfde resultaten rechtstreeks naar een
 * API sturen, zonder dat `ExportService` of de UI wijzigen — zie
 * docs/ARCHITECTURE.md.
 */
export interface StockResultExporter {
  exportResults(input: StockResultExportInput): Promise<ExportedFile>;
}
