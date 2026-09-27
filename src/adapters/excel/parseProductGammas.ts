import type { ProductCategory } from "../../domain/types";
import { extractDataRows, findHeaderRow } from "./excelHeaderUtils";
import { toBooleanFlag, toNumberOrNull, toStringOrNull } from "./excelValues";

export const PRODUCTGAMMAS_SHEET_NAME = "PRODUCTGAMMAS";

/**
 * Sprint 3.2 §14 (Excel portability): dedicated, machine-leesbare sheet die
 * de bedrijfsbrede/globale "Productgamma"-lijst (zie `ProductCategory` in
 * domain/types.ts) meeneemt in het gestandaardiseerde Excelbestand — zelfde
 * precedent als ARTIKEL_LOCATIES voor `ArticleLocationAssignment`.
 *
 * "Productgamma ID" is de stabiele `ProductCategory.id` (portable, hetzelfde
 * over alle kantoren/exports/imports heen — spec: nooit een nieuwe ID
 * genereren voor een reeds bekende categorie). "Naam"/"Volgorde"/"Actief"
 * zijn de overige, bewerkbare velden. Een artikel verwijst naar deze ID via
 * de optionele "Productgamma ID"-kolom in ARTIKEL (zie parseArtikel.ts) — de
 * koppeling zelf staat dus NIET hier, maar op het artikel, exact zoals
 * `Article.categoryId` in het domeinmodel.
 */
export const PRODUCTGAMMAS_REQUIRED_HEADERS = ["Productgamma ID", "Naam", "Volgorde", "Actief"] as const;

/**
 * Leest sheet PRODUCTGAMMAS in. Rijen zonder ID of zonder (niet-lege) naam
 * worden bewust genegeerd (defensief tegen een handmatig bewerkt of
 * anderszins corrupt bestand) in plaats van de hele import te laten falen.
 *
 * "Volgorde" valt terug op de rijvolgorde in het bestand (1-based) wanneer de
 * cel leeg/ongeldig is — nooit een crash op een handmatig leeggehaalde cel.
 */
export function parseProductGammasSheet(rows: unknown[][]): ProductCategory[] {
  const { headerRowIndex, columnIndexByName } = findHeaderRow(
    rows,
    [...PRODUCTGAMMAS_REQUIRED_HEADERS],
    PRODUCTGAMMAS_SHEET_NAME,
  );
  const dataRows = extractDataRows(rows, headerRowIndex, columnIndexByName);

  const categories: ProductCategory[] = [];
  dataRows.forEach((row, index) => {
    const id = toStringOrNull(row["Productgamma ID"]);
    const name = toStringOrNull(row["Naam"]);
    if (!id || !name) return;

    categories.push({
      id,
      name,
      sortOrder: toNumberOrNull(row["Volgorde"]) ?? index + 1,
      active: toBooleanFlag(row["Actief"], true),
    });
  });
  return categories;
}
