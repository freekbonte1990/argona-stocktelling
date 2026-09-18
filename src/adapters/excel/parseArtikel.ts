import { normalizeArticleStatus, normalizeFrequency } from "../../domain/frequency";
import type { Article } from "../../domain/types";
import { ExcelValidationError } from "./excelErrors";
import { extractDataRows, findHeaderRow } from "./excelHeaderUtils";
import { toNumberOrNull, toStringOrNull } from "./excelValues";

export const ARTIKEL_SHEET_NAME = "ARTIKEL";

export const ARTIKEL_REQUIRED_HEADERS = [
  "Artikelnr.",
  "Officieel artikelnr.",
  "ID type",
  "Omschrijving",
  "Productgroep",
  "Leverancier",
  "Eenheid",
  "Kostprijs",
  "TELPERIODE",
  "Artikelstatus",
  "Vorige telling",
  "Bronrij",
] as const;

/**
 * Leest sheet ARTIKEL in en zet elke rij om naar een domein-Article.
 * Tijdelijke artikelnummers (bv. "TMP-DAM-0001") zijn gewoon geldige,
 * niet-lege strings en worden niet geweigerd.
 */
export function parseArtikelSheet(rows: unknown[][], officeId: string): Article[] {
  const { headerRowIndex, columnIndexByName } = findHeaderRow(
    rows,
    [...ARTIKEL_REQUIRED_HEADERS],
    ARTIKEL_SHEET_NAME,
  );
  const dataRows = extractDataRows(rows, headerRowIndex, columnIndexByName);

  return dataRows.map((row, index) => buildArticle(row, officeId, headerRowIndex + 2 + index));
}

function buildArticle(
  row: Record<string, unknown>,
  officeId: string,
  excelRowNumber: number,
): Article {
  const articleNumber = toStringOrNull(row["Artikelnr."]);
  if (!articleNumber) {
    throw new ExcelValidationError(
      `Kolom "Artikelnr." is leeg in sheet ARTIKEL, rij ${excelRowNumber}. Elk artikel heeft een artikelnummer nodig (een tijdelijk nummer zoals TMP-... mag ook).`,
    );
  }

  const rawCountPeriod = toStringOrNull(row["TELPERIODE"]);
  const rawStatus = toStringOrNull(row["Artikelstatus"]);
  const sourceRow = toNumberOrNull(row["Bronrij"]);

  return {
    id: `${officeId}:${articleNumber}`,
    officeId,
    articleNumber,
    officialArticleNumber: toStringOrNull(row["Officieel artikelnr."]),
    idType: toStringOrNull(row["ID type"]),
    description: toStringOrNull(row["Omschrijving"]) ?? "",
    productGroup: toStringOrNull(row["Productgroep"]),
    supplier: toStringOrNull(row["Leverancier"]),
    unit: toStringOrNull(row["Eenheid"]),
    costPrice: toNumberOrNull(row["Kostprijs"]),
    rawCountPeriod,
    countPeriod: normalizeFrequency(rawCountPeriod),
    rawStatus,
    status: normalizeArticleStatus(rawStatus),
    previousCount: toNumberOrNull(row["Vorige telling"]),
    sourceRow: sourceRow ?? excelRowNumber,
  };
}
