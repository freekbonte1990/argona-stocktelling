import type ExcelJS from "exceljs";

/**
 * Gedeelde opmaakconstantes voor de exportlaag (aanvulling: "we moeten exact
 * de layout van de bron terug leveren"). Deze waarden zijn NIET verzonnen —
 * ze zijn overgenomen uit de echte, standaard Argona-sjablonen
 * (test-fixtures/Stocktelling_*_standaard.xlsx, geïnspecteerd cel per cel:
 * kleuren, lettertypes, kolombreedtes, bevroren rijen/kolommen,
 * getalnotaties). Elk kantoor gebruikt exact hetzelfde sjabloon (bevestigd:
 * Damme/Lokeren/Antwerpen delen identieke opmaak), dus deze module hardcodet
 * bewust die ene, vaste huisstijl in plaats van opmaak dynamisch over te
 * nemen uit een geïmporteerd bestand (dat zou toch nooit iets anders zijn).
 *
 * Kleurherkomst (uit het thema van het bronbestand, `xl/theme/theme1.xml`):
 * - ARTIKEL/NIEUWE_ARTIKELEN-header: expliciete RGB-vulling #4472C4.
 * - TELLING-header: themakleur accent3 (#196B24), tint 0.0 (onveranderd).
 * - TELLING-titelrij: themakleur accent1 (#156082), tint ±0.80 (zeer
 *   lichte tint, berekend via de standaard Excel-tintformule).
 * - TELLING LOCATIE-kolommen (databereik): themakleur accent5 (#A02B93),
 *   tint ±0.80.
 * - Tijdelijk-artikelnummer / ontbrekend-officieel-nummer: expliciete RGB
 *   #FCE4D6 (lichtperzik).
 * - "NOG TE BEPALEN" (telperiode) / NIEUWE_ARTIKELEN-invulrijen: expliciete
 *   RGB #FFF2CC (lichtgeel).
 */

export const HEADER_FONT_BLUE: Partial<ExcelJS.Font> = {
  name: "Arial",
  size: 10,
  bold: true,
  color: { argb: "FFFFFFFF" },
};

export const HEADER_FONT_GREEN: Partial<ExcelJS.Font> = { ...HEADER_FONT_BLUE };

export const HEADER_FILL_BLUE: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF4472C4" },
};

export const HEADER_FILL_GREEN: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF196B24" },
};

export const TITLE_FILL_PALE_BLUE: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFC1E5F5" },
};

export const HIGHLIGHT_FILL_PEACH: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFCE4D6" },
};

export const HIGHLIGHT_FILL_YELLOW: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF2CC" },
};

export const HIGHLIGHT_FILL_PURPLE: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF2CFEE" },
};

export const HEADER_ALIGNMENT: Partial<ExcelJS.Alignment> = {
  horizontal: "center",
  vertical: "middle",
};

export const CURRENCY_FORMAT = "€ #,##0.00";
export const CURRENCY_DIFF_FORMAT = "€ #,##0.00;[Red]-€ #,##0.00";
export const QUANTITY_FORMAT = "#,##0.##";
export const QUANTITY_DIFF_FORMAT = "#,##0.##;[Red]-#,##0.##";
export const DATE_FORMAT = "dd-mm-yyyy";

/** Stijlt een volledige rij als headerrij: witte vetgedrukte Arial 10, gecentreerd, gevuld. */
export function styleHeaderRow(row: ExcelJS.Row, fill: ExcelJS.Fill, columnCount: number): void {
  row.font = fill === HEADER_FILL_GREEN ? HEADER_FONT_GREEN : HEADER_FONT_BLUE;
  for (let col = 1; col <= columnCount; col++) {
    const cell = row.getCell(col);
    cell.fill = fill;
    cell.font = fill === HEADER_FILL_GREEN ? HEADER_FONT_GREEN : HEADER_FONT_BLUE;
    cell.alignment = HEADER_ALIGNMENT;
  }
}

/** Zet kolombreedtes (in Excel-"characters", zoals in het bronbestand). */
export function setColumnWidths(sheet: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
}
