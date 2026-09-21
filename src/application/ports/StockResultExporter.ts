import type { SessionReviewSummary } from "../../domain/review";
import type { Article, ArticleLocationAssignment, CountSession, Office } from "../../domain/types";

/**
 * Alles wat een exporter nodig heeft om de resultaten van een AFGEWERKTE (of
 * lopende) telling weg te schrijven. Bewust een plat data-object: de
 * resultaatberekening (`SessionReviewSummary`) gebeurt altijd vooraf in
 * `domain/review.ts`, nooit in de exporter zelf (spec v0.2 §5 — "schrijf
 * geen businesslogica rechtstreeks in de Excel-adapter").
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
}

export interface ExportedFile {
  fileName: string;
  /** Ruwe bestandsinhoud (.xlsx-bytes). */
  data: ArrayBuffer;
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
