import { ExcelValidationError } from "./excelErrors";
import { isRowBlank } from "./excelValues";

export interface HeaderLocation {
  /** 0-based rijindex (binnen de rows-array) waar de headerrij effectief staat. */
  headerRowIndex: number;
  /** Kolomnaam (exact zoals opgegeven in requiredHeaders) -> 0-based kolomindex. */
  columnIndexByName: Record<string, number>;
}

/**
 * Zoekt de headerrij van een sheet op basis van kolomNAMEN, niet op een vast
 * rijnummer. We scannen de eerste `maxScanRows` rijen en zoeken de eerste rij
 * die alle vereiste kolomnamen bevat (case-insensitive, whitespace getrimd).
 *
 * Zo blijft import werken ongeacht hoeveel metadata-rijen een kantoor boven
 * de tabel heeft staan (spec: "Hardcode niet dat de header altijd rij 14 is").
 */
export function findHeaderRow(
  rows: unknown[][],
  requiredHeaders: string[],
  sheetName: string,
  options: { maxScanRows?: number } = {},
): HeaderLocation {
  const maxScan = Math.min(rows.length, options.maxScanRows ?? 60);
  const normalizedRequired = requiredHeaders.map((header) => header.trim().toLowerCase());

  for (let rowIndex = 0; rowIndex < maxScan; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    const normalizedCells = row.map(normalizeHeaderCell);
    const missing = normalizedRequired.filter((header) => !normalizedCells.includes(header));
    if (missing.length === 0) {
      const columnIndexByName: Record<string, number> = {};
      for (const header of requiredHeaders) {
        columnIndexByName[header] = normalizedCells.indexOf(header.trim().toLowerCase());
      }
      return { headerRowIndex: rowIndex, columnIndexByName };
    }
  }

  throw new ExcelValidationError(
    `Kon de headerrij niet vinden in sheet "${sheetName}". ` +
      `Verwachte kolommen: ${requiredHeaders.join(", ")}.`,
  );
}

function normalizeHeaderCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim().toLowerCase();
}

/**
 * Sprint 2 (Historical Count Analysis) §14: vindt een OPTIONELE kolom (bv.
 * "Voorraadclassificatie" in ARTIKEL) op naam in de reeds gevonden
 * headerrij — in tegenstelling tot `findHeaderRow` gooit dit NOOIT een
 * fout wanneer de kolom ontbreekt (een bestand van vóór deze sprint kent ze
 * gewoon niet), maar geeft dan `null` terug. De aanroeper voegt de
 * gevonden index (indien niet `null`) toe aan `columnIndexByName` vóór
 * `extractDataRows`, zodat die kolom net als een verplichte kolom wordt
 * meegelezen wanneer aanwezig, en anders overal `null` blijft opleveren.
 */
export function findOptionalColumnIndex(
  rows: unknown[][],
  headerRowIndex: number,
  columnName: string,
): number | null {
  const row = rows[headerRowIndex] ?? [];
  const normalized = columnName.trim().toLowerCase();
  const index = row.findIndex((cell) => normalizeHeaderCell(cell) === normalized);
  return index >= 0 ? index : null;
}

/**
 * Leest alle datarijen na de headerrij, tot en met de eerste volledig lege rij
 * (of het einde van de sheet). Geeft per rij een record terug, gesleuteld op
 * de kolomnamen uit `columnIndexByName`.
 */
export function extractDataRows(
  rows: unknown[][],
  headerRowIndex: number,
  columnIndexByName: Record<string, number>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    if (isRowBlank(row)) break;
    const record: Record<string, unknown> = {};
    for (const [header, colIndex] of Object.entries(columnIndexByName)) {
      record[header] = colIndex >= 0 ? row[colIndex] : null;
    }
    result.push(record);
  }
  return result;
}
