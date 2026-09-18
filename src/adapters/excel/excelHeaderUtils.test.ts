import { describe, expect, it } from "vitest";
import { extractDataRows, findHeaderRow } from "./excelHeaderUtils";
import { ExcelValidationError } from "./excelErrors";
import { ARTIKEL_HEADER_ROW } from "./testWorkbook";

describe("findHeaderRow — header op naam, niet op vast rijnummer", () => {
  it("vindt de header wanneer die op rij 14 (index 13) staat, zoals in de standaard-bestanden", () => {
    const rows: unknown[][] = [...Array.from({ length: 13 }, () => ["metadata"]), ARTIKEL_HEADER_ROW];
    const { headerRowIndex } = findHeaderRow(rows, [...ARTIKEL_HEADER_ROW] as string[], "ARTIKEL");
    expect(headerRowIndex).toBe(13);
  });

  it("vindt de header even goed wanneer die op een heel andere rij staat", () => {
    const rows: unknown[][] = [["iets"], [], ARTIKEL_HEADER_ROW];
    const { headerRowIndex } = findHeaderRow(rows, [...ARTIKEL_HEADER_ROW] as string[], "ARTIKEL");
    expect(headerRowIndex).toBe(2);
  });

  it("herkent kolomnamen case-insensitive en met omliggende spaties", () => {
    const rows: unknown[][] = [[" artikelnr. ", " OMSCHRIJVING"]];
    const { columnIndexByName } = findHeaderRow(rows, ["Artikelnr.", "Omschrijving"], "ARTIKEL");
    expect(columnIndexByName["Artikelnr."]).toBe(0);
    expect(columnIndexByName["Omschrijving"]).toBe(1);
  });

  it("gooit een begrijpelijke fout wanneer een verplichte kolom nergens gevonden wordt", () => {
    const rows: unknown[][] = [["Artikelnr.", "Omschrijving"]];
    expect(() => findHeaderRow(rows, ["Artikelnr.", "Productgroep"], "ARTIKEL")).toThrow(
      ExcelValidationError,
    );
  });
});

describe("extractDataRows", () => {
  it("stopt bij de eerste volledig lege rij", () => {
    const rows: unknown[][] = [
      ["Artikelnr.", "Omschrijving"],
      ["A1", "Eerste"],
      ["A2", "Tweede"],
      [null, null],
      ["A3", "Zou niet meegenomen mogen worden"],
    ];
    const { headerRowIndex, columnIndexByName } = findHeaderRow(rows, ["Artikelnr.", "Omschrijving"], "ARTIKEL");
    const data = extractDataRows(rows, headerRowIndex, columnIndexByName);
    expect(data).toHaveLength(2);
    expect(data[0]["Artikelnr."]).toBe("A1");
    expect(data[1]["Artikelnr."]).toBe("A2");
  });
});
