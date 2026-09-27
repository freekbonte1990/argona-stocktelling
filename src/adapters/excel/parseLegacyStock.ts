import * as XLSX from "xlsx";
import { normalizeQuarterLabelToPeriodKey } from "../../domain/legacyPeriods";
import type { LegacyStockRow } from "../../domain/legacyImport";
import { extractDataRows, findHeaderRow } from "./excelHeaderUtils";
import { toNumberOrNull, toStringOrNull } from "./excelValues";
import { ExcelValidationError } from "./excelErrors";

/**
 * Sprint 3.3 §3: pragmatische, bewust HARDGECODEERDE lezers voor de twee
 * concrete, echte historische stockbestanden die Argona aanleverde (TGOVL =
 * kantoor Lokeren, TGWVL = kantoor Damme) — geen generieke "lees eender welk
 * legacy-Excelbestand"-machine. Beide bestanden hebben een grondig
 * onderzochte, eigen, inconsistente structuur (losse werkbladen per periode,
 * soms brede "bewegingsrapport"-tabbladen met meerdere periodes naast
 * elkaar, gebroken `#REF!`-formules in oudere vergelijkingskolommen). Zie
 * `docs/` voor geen apart document hierover — de keuzes staan hieronder per
 * blad toegelicht.
 *
 * Gedeelde truc die het meeste hardcoderen overbodig maakt: `findHeaderRow`
 * zoekt een kolom op NAAM, en geeft bij een NAAM die meerdere keren voorkomt
 * (zoals "Aantal" in een breed "bewegingsrapport"-tabblad met meerdere
 * periodes naast elkaar) altijd de EERSTE (meest linkse) kolom terug — in
 * elk hieronder onderzocht tabblad is dat exact de kolomgroep van de eigen,
 * naar het tabblad genoemde periode (de oudere/vergelijkingsperiodes staan
 * er altijd RECHTS van). Hierdoor is er geen enkele handmatige
 * kolomindex-rekenkunde nodig, enkel de kolomNAMEN per tabblad.
 */

function readLegacyWorkbook(buffer: ArrayBuffer, fileName: string): XLSX.WorkBook {
  try {
    return XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    throw new ExcelValidationError(
      `Kon "${fileName}" niet lezen als Excelbestand. Controleer of het bestand niet beschadigd is en een .xlsx-bestand is.`,
    );
  }
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
}

/**
 * "NEE" -> false, elke "JA..."-variant (JA - ROOD/JA - PANEEL/JA - HUAWEI/...) -> true,
 * leeg/onherkenbaar -> null ("onbekend", spec: nooit verzinnen).
 */
function parseObsoleteFlag(raw: string | null): boolean | null {
  if (!raw) return null;
  const value = raw.trim().toUpperCase();
  if (value === "NEE" || value === "NEEN") return false;
  if (value.startsWith("JA")) return true;
  return null;
}

interface SheetExtractionSpec {
  sheetName: string;
  /** Vaste periodesleutel voor ELKE rij van dit tabblad, of `null` om per rij een kolom te normaliseren (`periodColumn`). */
  fixedPeriodKey: string | null;
  /** Enkel gebruikt wanneer `fixedPeriodKey` null is — kolomnaam met een "Q1 2025"-achtig label per rij. */
  periodColumn?: string;
  productGroupColumn: string | null;
  obsoleteColumn: string | null;
  descriptionColumn: string;
  articleNumberColumn: string | null;
  costPriceColumn: string;
  quantityColumn: string;
  /** Vast label voor rijen zonder eigen Producttype-kolom (bv. de C4U-tabbladen). */
  fixedProductGroup?: string;
}

function extractRows(workbook: XLSX.WorkBook, spec: SheetExtractionSpec): LegacyStockRow[] {
  const sheet = workbook.Sheets[spec.sheetName];
  if (!sheet) return [];

  const aoa = sheetToRows(sheet);
  const requiredHeaders = [
    spec.descriptionColumn,
    spec.costPriceColumn,
    spec.quantityColumn,
    ...(spec.articleNumberColumn ? [spec.articleNumberColumn] : []),
    ...(spec.productGroupColumn ? [spec.productGroupColumn] : []),
    ...(spec.obsoleteColumn ? [spec.obsoleteColumn] : []),
    ...(spec.periodColumn ? [spec.periodColumn] : []),
  ];
  const { headerRowIndex, columnIndexByName } = findHeaderRow(aoa, requiredHeaders, spec.sheetName);
  const dataRows = extractDataRows(aoa, headerRowIndex, columnIndexByName);

  const rows: LegacyStockRow[] = [];
  dataRows.forEach((row, index) => {
    const description = toStringOrNull(row[spec.descriptionColumn]);
    if (!description) return; // rij zonder omschrijving is geen bruikbare artikelrij (bv. een lege/tussenrij).

    const periodKey = spec.fixedPeriodKey ?? normalizeQuarterLabelToPeriodKey(toStringOrNull(row[spec.periodColumn ?? ""]));
    if (!periodKey) return; // geen herkenbare periode voor deze rij — bewust overgeslagen i.p.v. geraden.

    rows.push({
      periodKey,
      sourceProductGroup: spec.fixedProductGroup ?? (spec.productGroupColumn ? toStringOrNull(row[spec.productGroupColumn]) : null),
      description,
      articleNumber: spec.articleNumberColumn ? toStringOrNull(row[spec.articleNumberColumn]) : null,
      originalCostPrice: toNumberOrNull(row[spec.costPriceColumn]),
      quantity: toNumberOrNull(row[spec.quantityColumn]),
      obsolete: spec.obsoleteColumn ? parseObsoleteFlag(toStringOrNull(row[spec.obsoleteColumn])) : null,
      sourceRef: `${spec.sheetName}!row${headerRowIndex + index + 2}`,
    });
  });
  return rows;
}

/**
 * Kantoor Lokeren (bronbestand "TGOVL"). Twee bronnen:
 *   - sheet DATA: één doorlopende rij per artikel per periode (DATUM-kolom,
 *     waarden zoals "Q12025"/"Q2 2025"), dekt Q1 2025 t/m Q2 2026 — de
 *     schoonste bron, ALTIJD de oorspronkelijke kostprijs (`cPurchaseprice`,
 *     nooit een afgewaardeerde kolom).
 *   - sheet "01 09 2026": de laatst vereiste periode. DATA kent deze datum
 *     zelf niet als apart DATUM-label (het onderliggende bestand draagt de
 *     laatst bekende fysieke telling, Q2 2026, gewoon door tot dit
 *     meetmoment) — apart uitgelezen en expliciet aan periode 2026-09-01
 *     gekoppeld.
 */
export function parseLegacyStockLokeren(buffer: ArrayBuffer, fileName: string): LegacyStockRow[] {
  const workbook = readLegacyWorkbook(buffer, fileName);
  return [
    ...extractRows(workbook, {
      sheetName: "DATA",
      fixedPeriodKey: null,
      periodColumn: "DATUM",
      productGroupColumn: "cProducttype",
      obsoleteColumn: "OBSOLETE?",
      descriptionColumn: "cProduct",
      articleNumberColumn: "cArticlenumber",
      costPriceColumn: "cPurchaseprice",
      quantityColumn: "Quantity Total",
    }),
    ...extractRows(workbook, {
      sheetName: "01 09 2026",
      fixedPeriodKey: "2026-09-01",
      productGroupColumn: "cProducttype",
      obsoleteColumn: "OBSOLETE?",
      descriptionColumn: "cProduct",
      articleNumberColumn: "cArticlenumber",
      costPriceColumn: "Kostprijs",
      quantityColumn: "AANTAL TELLING",
    }),
  ];
}

/**
 * Kantoor Damme (bronbestand "TGWVL", label "STOCK DAMME" letterlijk
 * aangetroffen in het bestand). Per vereiste periode het schoonste
 * beschikbare tabblad:
 *   - 31/03/2025 en 30/06/2025: eigen, simpele "Stock DD.MM.YYYY"-tabbladen
 *     (Aankoopprijs/Aantal/Inkoopwaarde) — plus de aparte "C4U Stock
 *     DD.MM.YYYY"-tabbladen (ander productmerk/subbedrijf, eigen
 *     kolomstructuur zonder artikelnummer/Producttype);
 *   - 30/09/2025, 31/12/2025, 31/03/2026, 30/06/2026, 01/09/2026: bredere
 *     "bewegingsrapport"-tabbladen (huidige periode + vergelijkingen met
 *     oudere periodes ernaast, soms met `#REF!`-fouten in die
 *     vergelijkingskolommen) — enkel de EERSTE (eigen) Aantal/Eenheidsprijs-
 *     kolomgroep wordt gelezen, nooit de vergelijkingskolommen ernaast.
 * Geen C4U-tabblad bekend voor deze latere periodes (enkel de 2025Q1/Q2
 * C4U-tabbladen bestaan) — dat is geen omissie hier, gewoon wat het bestand
 * bevat.
 */
export function parseLegacyStockDamme(buffer: ArrayBuffer, fileName: string): LegacyStockRow[] {
  const workbook = readLegacyWorkbook(buffer, fileName);
  return [
    ...extractRows(workbook, {
      sheetName: "Stock 31.03.2025",
      fixedPeriodKey: "2025-03-31",
      productGroupColumn: "Producttype",
      obsoleteColumn: null,
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Aankoopprijs",
      quantityColumn: "Aantal",
    }),
    ...extractRows(workbook, {
      sheetName: "C4U Stock 31.03.2025",
      fixedPeriodKey: "2025-03-31",
      fixedProductGroup: "C4U",
      productGroupColumn: null,
      obsoleteColumn: null,
      descriptionColumn: "Naam",
      articleNumberColumn: null,
      costPriceColumn: "Aankoopprijs",
      quantityColumn: "Voorraad",
    }),
    ...extractRows(workbook, {
      sheetName: "Stock 30.06.2025",
      fixedPeriodKey: "2025-06-30",
      productGroupColumn: "Producttype",
      obsoleteColumn: null,
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Aankoopprijs",
      quantityColumn: "Aantal",
    }),
    ...extractRows(workbook, {
      sheetName: "C4U Stock 30.06.2025",
      fixedPeriodKey: "2025-06-30",
      fixedProductGroup: "C4U",
      productGroupColumn: null,
      obsoleteColumn: null,
      descriptionColumn: "Naam",
      articleNumberColumn: null,
      costPriceColumn: "Aankoopprijs",
      quantityColumn: "Voorraad",
    }),
    ...extractRows(workbook, {
      sheetName: "Stock 30.09.2025",
      fixedPeriodKey: "2025-09-30",
      productGroupColumn: "Producttype",
      obsoleteColumn: null,
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Eenheidsprijs",
      quantityColumn: "Aantal",
    }),
    ...extractRows(workbook, {
      sheetName: "Stock 31.12.2025",
      fixedPeriodKey: "2025-12-31",
      productGroupColumn: "Producttype",
      obsoleteColumn: "OBSOLETE?",
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Eenheidsprijs",
      quantityColumn: "Aantal",
    }),
    ...extractRows(workbook, {
      sheetName: "Stock 31.03.2026",
      fixedPeriodKey: "2026-03-31",
      productGroupColumn: "Producttype",
      obsoleteColumn: "OBSOLETE?",
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Eenheidsprijs",
      quantityColumn: "Aantal",
    }),
    ...extractRows(workbook, {
      sheetName: "Stock 30.06.2026",
      fixedPeriodKey: "2026-06-30",
      productGroupColumn: "Producttype",
      obsoleteColumn: "OBSOLETE?",
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Eenheidsprijs",
      quantityColumn: "Aantal",
    }),
    ...extractRows(workbook, {
      sheetName: "Stock 01.09.2026 ",
      fixedPeriodKey: "2026-09-01",
      productGroupColumn: "Producttype",
      obsoleteColumn: "OBSOLETE?",
      descriptionColumn: "Product",
      articleNumberColumn: "Artikelnummer",
      costPriceColumn: "Eenheidsprijs",
      quantityColumn: "Aantal",
    }),
  ];
}
