import * as XLSX from "xlsx";

/**
 * Test-helper: bouwt een in-memory .xlsx-workbook (als ArrayBuffer) met de
 * drie verplichte sheets, zodat tests geen echte bestanden op schijf nodig
 * hebben. Wordt enkel door tests gebruikt.
 */
export interface TestWorkbookOptions {
  configRows: unknown[][];
  artikelRows: unknown[][];
  tellingRows: unknown[][];
  sheetNames?: { config?: string; artikel?: string; telling?: string };
}

export function buildTestWorkbookBuffer(options: TestWorkbookOptions): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const names = {
    config: options.sheetNames?.config ?? "CONFIG",
    artikel: options.sheetNames?.artikel ?? "ARTIKEL",
    telling: options.sheetNames?.telling ?? "TELLING",
  };
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(options.configRows), names.config);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(options.artikelRows), names.artikel);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(options.tellingRows), names.telling);
  const out = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return out;
}

export const TELLING_HEADER_ROW: unknown[] = [
  "Artikelnr.",
  "Omschrijving",
  "Productgroep",
  "Leverancier",
  "Artikelstatus",
  "TELPERIODE",
  "Eenheid",
  "Vorige telling",
  "Kostprijs",
  "Waarde vorige telling",
  "LOCATIE 1",
  "LOCATIE 2",
  "LOCATIE 3",
  "LOCATIE 4",
  "LOCATIE 5",
  "Opmerking",
  "AANTAL TOTAAL",
  "Bedrag",
  "Verschil Bedrag",
  "VERSCHIL AANTAL",
  "GETELD?",
];

export const ARTIKEL_HEADER_ROW: unknown[] = [
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
];

export function defaultConfigRows(officeName = "Antwerpen"): unknown[][] {
  return [
    ["Kantoor", officeName],
    ["Basisdatum", "2026-09-01"],
    ["Locatie 1 naam", "Magazijn"],
    ["Locatie 2 naam", ""],
    ["Locatie 3 naam", null],
    ["Locatie 4 naam", ""],
    ["Locatie 5 naam", ""],
  ];
}

export function defaultTellingRows(): unknown[][] {
  return [
    ["Argona Stocktelling"],
    [],
    ["Kantoor", "Antwerpen"],
    [],
    ...Array.from({ length: 8 }, () => []),
    TELLING_HEADER_ROW,
  ];
}
