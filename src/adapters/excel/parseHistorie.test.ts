import { describe, expect, it } from "vitest";
import { HISTORIE_REQUIRED_HEADERS, parseHistorieSheet } from "./parseHistorie";

function rowsWithHeader(dataRows: unknown[][]): unknown[][] {
  return [[...HISTORIE_REQUIRED_HEADERS], ...dataRows];
}

describe("parseHistorieSheet", () => {
  it("leest een normale GETELD-regel correct in", () => {
    const rows = rowsWithHeader([
      [
        "2026-09-30",
        "MONTHLY",
        "2026-09 Maand",
        "A1",
        "Artikel A1",
        8,
        10,
        -2,
        2,
        -4,
        "GETELD",
        "Rek A",
      ],
    ]);
    const entries = parseHistorieSheet(rows, "office");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      countDate: "2026-09-30",
      sessionType: "MONTHLY",
      sessionName: "2026-09 Maand",
      articleId: "office:A1",
      articleNumber: "A1",
      totalCount: 8,
      previousCount: 10,
      differenceQuantity: -2,
      costPrice: 2,
      differenceAmount: -4,
      status: "GETELD",
      locationNames: ["Rek A"],
    });
  });

  it("leest een OVERGENOMEN-regel zonder locaties correct in (geen fictieve 0)", () => {
    const rows = rowsWithHeader([
      ["2026-09-30", "MONTHLY", "2026-09 Maand", "Q1", "Artikel Q1", 12, 12, 0, 3, 0, "OVERGENOMEN", null],
    ]);
    const entries = parseHistorieSheet(rows, "office");
    expect(entries[0].status).toBe("OVERGENOMEN");
    expect(entries[0].totalCount).toBe(12);
    expect(entries[0].locationNames).toEqual([]);
  });

  it("herkent '0 BEVESTIGD' als status", () => {
    const rows = rowsWithHeader([
      ["2026-09-30", "MONTHLY", "2026-09 Maand", "A2", "Artikel A2", 0, 5, -5, 1, -5, "0 BEVESTIGD", null],
    ]);
    const entries = parseHistorieSheet(rows, "office");
    expect(entries[0].status).toBe("0 BEVESTIGD");
    expect(entries[0].totalCount).toBe(0);
  });

  it("splitst meerdere locatienamen op komma", () => {
    const rows = rowsWithHeader([
      ["2026-09-30", "MONTHLY", "2026-09 Maand", "A1", "Artikel A1", 8, 10, -2, 2, -4, "GETELD", "Rek A, Rek B"],
    ]);
    const entries = parseHistorieSheet(rows, "office");
    expect(entries[0].locationNames).toEqual(["Rek A", "Rek B"]);
  });
});
