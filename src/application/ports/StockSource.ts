import type { Article, Office } from "../../domain/types";

/**
 * Bron van stockgegevens (kantoor, locaties, artikelen).
 *
 * Dit is de enige plek waar de rest van de applicatie met "waar komen de
 * artikelen vandaan" te maken heeft. Vandaag is dat een reeds ingelezen
 * Excelbestand (ExcelStockSource). Later kan dit een EBuddyStockSource
 * worden die live over een API praat — zonder dat domein, services of UI
 * wijzigen. Zie docs/ARCHITECTURE.md.
 */
export interface StockSource {
  loadOffice(): Promise<Office>;
  loadArticles(office: Office): Promise<Article[]>;
  /** Bestandsnaam / bronaanduiding, puur informatief (getoond in de UI, bewaard op de sessie). */
  readonly sourceLabel: string;
}
