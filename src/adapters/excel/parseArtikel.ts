import { normalizeArticleStatus, normalizeFrequency } from "../../domain/frequency";
import { normalizeStockClassification } from "../../domain/stockClassification";
import type { Article } from "../../domain/types";
import { ExcelValidationError } from "./excelErrors";
import { extractDataRows, findHeaderRow, findOptionalColumnIndex } from "./excelHeaderUtils";
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
 * Sprint 2 (Historical Count Analysis) §5/§14: "Voorraadclassificatie"
 * (ACTIVE/OBSOLETE) is een OPTIONELE kolom in ARTIKEL — een bestand van
 * vóór deze sprint kent ze niet, en moet probleemloos blijven importeren
 * (backward compat, exact zoals ARTIKEL_LOCATIES/"Locatie N ID" hiervoor).
 * Bewust NIET in `ARTIKEL_REQUIRED_HEADERS`: die lijst gooit een fout zodra
 * één van de kolommen ontbreekt, wat deze optionele kolom nooit mag doen.
 */
export const STOCK_CLASSIFICATION_HEADER = "Voorraadclassificatie";

/**
 * Sprint 3.2 §14 (Excel portability): "Productgamma ID" — de stabiele,
 * globale `ProductCategory.id` (zie parseProductGammas.ts) waaraan dit
 * artikel toegewezen is. Bewust OPTIONEEL, zelfde precedent als
 * `STOCK_CLASSIFICATION_HEADER` hierboven: een bestand van vóór Sprint 3.2
 * kent deze kolom niet en moet probleemloos blijven importeren.
 *
 * Backward-compatibiliteit/full-replacement-precedent (zie ook
 * ImportService/ExportService): ontbreekt de kolom volledig (oud bestand),
 * dan blijft `Article.categoryId` `undefined` (nooit `null`) — dat is een
 * signaal voor latere logica (bv. de eenmalige migratiebootstrap) dat dit
 * artikel nog nooit geclassificeerd kon zijn. Is de kolom wél aanwezig maar
 * de cel leeg, dan wordt expliciet `null` gezet ("bewust niet ingedeeld").
 */
export const CATEGORY_ID_HEADER = "Productgamma ID";

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
  const stockClassificationColIndex = findOptionalColumnIndex(
    rows,
    headerRowIndex,
    STOCK_CLASSIFICATION_HEADER,
  );
  const categoryIdColIndex = findOptionalColumnIndex(rows, headerRowIndex, CATEGORY_ID_HEADER);
  const columnIndexByNameWithOptional = {
    ...columnIndexByName,
    ...(stockClassificationColIndex !== null
      ? { [STOCK_CLASSIFICATION_HEADER]: stockClassificationColIndex }
      : {}),
    ...(categoryIdColIndex !== null ? { [CATEGORY_ID_HEADER]: categoryIdColIndex } : {}),
  };
  const dataRows = extractDataRows(rows, headerRowIndex, columnIndexByNameWithOptional);

  return dataRows.map((row, index) =>
    buildArticle(row, officeId, headerRowIndex + 2 + index, categoryIdColIndex !== null),
  );
}

function buildArticle(
  row: Record<string, unknown>,
  officeId: string,
  excelRowNumber: number,
  hasCategoryIdColumn: boolean,
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
    // Sprint 2 §14: ontbreekt de kolom (bestand van vóór deze sprint), dan
    // is `row[STOCK_CLASSIFICATION_HEADER]` altijd `undefined` (nooit
    // meegelezen door extractDataRows) -> `toStringOrNull` geeft `null` ->
    // veilige default ACTIVE, exact zoals spec §14 vraagt.
    stockClassification: normalizeStockClassification(toStringOrNull(row[STOCK_CLASSIFICATION_HEADER])),
    // Sprint 3.2 §14: enkel zetten (mogelijk `null`) wanneer de kolom
    // effectief in dit bestand aanwezig is — anders blijft `categoryId`
    // `undefined`, zie de toelichting bij `CATEGORY_ID_HEADER` hierboven.
    ...(hasCategoryIdColumn ? { categoryId: toStringOrNull(row[CATEGORY_ID_HEADER]) } : {}),
  };
}
