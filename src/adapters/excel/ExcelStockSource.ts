import * as XLSX from "xlsx";
import type { Article, Location, Office } from "../../domain/types";
import type { StockSource } from "../../application/ports/StockSource";
import { slugify } from "../../shared/ids";
import { ARTIKEL_SHEET_NAME, parseArtikelSheet } from "./parseArtikel";
import { CONFIG_SHEET_NAME, parseConfigSheet } from "./parseConfig";
import { TELLING_SHEET_NAME, validateTellingSheet } from "./parseTelling";
import { ExcelValidationError } from "./excelErrors";

/**
 * StockSource-adapter die een reeds geparste Argona-stocktelling Excelbestand
 * teruggeeft als domeinobjecten. Het bestand wordt volledig gevalideerd en
 * geparst zodra dit object gemaakt wordt (zie createExcelStockSourceFromBuffer),
 * zodat validatiefouten meteen zichtbaar zijn en niet pas bij gebruik.
 */
export class ExcelStockSource implements StockSource {
  private readonly office: Office;
  private readonly articles: Article[];
  readonly sourceLabel: string;

  constructor(office: Office, articles: Article[], sourceLabel: string) {
    this.office = office;
    this.articles = articles;
    this.sourceLabel = sourceLabel;
  }

  async loadOffice(): Promise<Office> {
    return this.office;
  }

  async loadArticles(_office: Office): Promise<Article[]> {
    return this.articles;
  }
}

export async function createExcelStockSourceFromFile(file: File): Promise<ExcelStockSource> {
  const buffer = await file.arrayBuffer();
  return createExcelStockSourceFromBuffer(buffer, file.name);
}

export function createExcelStockSourceFromBuffer(
  buffer: ArrayBuffer,
  sourceFileName: string,
): ExcelStockSource {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    throw new ExcelValidationError(
      `Kon "${sourceFileName}" niet lezen als Excelbestand. Controleer of het bestand niet beschadigd is en een .xlsx-bestand is.`,
    );
  }

  const configRows = sheetToRows(getSheetOrThrow(workbook, CONFIG_SHEET_NAME));
  const artikelRows = sheetToRows(getSheetOrThrow(workbook, ARTIKEL_SHEET_NAME));
  const tellingRows = sheetToRows(getSheetOrThrow(workbook, TELLING_SHEET_NAME));

  const parsedConfig = parseConfigSheet(configRows);
  const officeId = slugify(parsedConfig.officeName);

  // v0.2.1 §1: dynamisch aantal locaties, gelezen uit CONFIG — geen vaste 5
  // meer. Een bestand zonder enige "Locatie N naam/actief"-rij (zou niet
  // mogen voorkomen bij een geldig sjabloon) valt terug op één locatie, zodat
  // er nooit een kantoor met nul locaties ontstaat.
  const parsedLocations = parsedConfig.locations.length > 0 ? parsedConfig.locations : [{ name: null, active: true }];

  // Sheet TELLING wordt gevalideerd (kolommen aanwezig, header op naam
  // gezocht, incl. exact evenveel LOCATIE-kolommen als CONFIG aangeeft) maar
  // de rijgegevens worden in v0.1 niet gebruikt — zie parseTelling.ts.
  validateTellingSheet(tellingRows, parsedLocations.length);

  const locations: Location[] = parsedLocations.map((parsedLocation, index) => {
    const number = index + 1;
    return {
      id: `${officeId}:loc-${number}`,
      officeId,
      number,
      name: parsedLocation.name ?? `Locatie ${number}`,
      active: parsedLocation.active,
    };
  });

  const office: Office = {
    id: officeId,
    name: parsedConfig.officeName,
    baseDate: parsedConfig.baseDate,
    locations,
  };

  const articles = parseArtikelSheet(artikelRows, officeId);

  return new ExcelStockSource(office, articles, sourceFileName);
}

function getSheetOrThrow(workbook: XLSX.WorkBook, sheetName: string): XLSX.WorkSheet {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new ExcelValidationError(`Sheet "${sheetName}" ontbreekt in het Excelbestand.`);
  }
  return sheet;
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
}
