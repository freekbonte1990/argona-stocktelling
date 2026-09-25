import type { StockHistoryEntry } from "../../domain/stockSnapshot";
import type { Article, ArticleLocationAssignment, Office } from "../../domain/types";

/**
 * Eén nog niet-geïnterpreteerd, historisch tellingtabblad zoals aangetroffen
 * in een geïmporteerd rollend Excelbestand (spec: "een bestaand historisch
 * tellingtabblad mag nooit gewijzigd of overschreven worden"). `rows` is de
 * ruwe rij-representatie (zoals `sheet_to_json({header:1})` teruggeeft) —
 * bewust ondoorzichtig voor het domein: dit bestaat uitsluitend om zo'n tab
 * byte-/logisch ongewijzigd te kunnen doorgeven bij een volgende export. Een
 * latere eBuddy-bron heeft dit concept niet nodig (die bewaart StockSnapshot
 * al gestructureerd) en implementeert `loadHistoricalSheets` dan ook niet.
 */
export interface HistoricalSheetSnapshot {
  sheetName: string;
  rows: unknown[][];
}

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
  /**
   * Machinevriendelijke telhistoriek uit een eerder geëxporteerd rollend
   * bestand (sheet HISTORIE) — spec: "een nieuw toestel/browser moet
   * onmiddellijk historische grafieken kunnen tonen na import, zonder dat de
   * oude CountSessions lokaal aanwezig zijn". OPTIONEEL: bewust `?` zodat
   * bestaande/toekomstige StockSource-implementaties (en oudere,
   * gestandaardiseerde bestanden zonder HISTORIE) dit niet moeten
   * ondersteunen — ontbreekt de methode of de sheet, dan is er gewoon nog
   * geen geïmporteerde historiek.
   */
  loadHistory?(): Promise<StockHistoryEntry[]>;
  /**
   * Alle overige, niet-standaard sheets uit het bronbestand (de benoemde
   * historische tellingtabs, bv. "2026-08 Maand") — puur ondoorzichtige
   * passthrough, zie `HistoricalSheetSnapshot`. Optioneel om dezelfde reden
   * als `loadHistory`.
   */
  loadHistoricalSheets?(): Promise<HistoricalSheetSnapshot[]>;
  /**
   * Production-pilot-readiness sprint punt 1 ("Excel portability"): geleerde
   * `ArticleLocationAssignment`'s uit een eerder geëxporteerd bestand (sheet
   * ARTIKEL_LOCATIES) — spec: "een volledig lege tablet/browser moet na
   * import meteen weten waar elk artikel normaal verwacht wordt, zonder
   * opnieuw te moeten leren". OPTIONEEL om dezelfde reden als `loadHistory`:
   * ontbreekt de methode of de sheet, dan is er gewoon nog niets geleerd
   * gekend uit dit bestand.
   */
  loadArticleLocationAssignments?(): Promise<ArticleLocationAssignment[]>;
}
