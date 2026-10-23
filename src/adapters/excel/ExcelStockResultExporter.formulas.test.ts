import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { computeSessionReview } from "../../domain/review";
import { buildHistoryEntriesFromSnapshot, buildSessionSnapshot } from "../../domain/stockSnapshot";
import type { Article, CountEntry, CountSession, Office } from "../../domain/types";

const office: Office = {
  id: "damme",
  name: "Damme",
  baseDate: "2026-08-28",
  locations: [1, 2].map((n) => ({ id: `damme:loc-${n}`, officeId: "damme", number: n, name: `Locatie ${n}`, active: true })),
};

function art(n: string, o: Partial<Article> = {}): Article {
  return {
    id: `damme:${n}`, officeId: "damme", articleNumber: n, officialArticleNumber: n, idType: "OFFICIEEL",
    description: `Artikel ${n}`, productGroup: "GROEP", supplier: null, unit: "STUKS", costPrice: 2,
    rawCountPeriod: "MAAND", countPeriod: "MONTHLY", rawStatus: "ACTIEF", status: "ACTIVE", previousCount: 10, sourceRow: 1, ...o,
  };
}

const session: CountSession = {
  id: "s1", officeId: "damme", type: "MONTHLY", status: "COMPLETED",
  startedAt: "2026-09-30T10:00:00.000Z", completedAt: "2026-09-30T15:00:00.000Z",
  sourceFileName: "t.xlsx", sourceBaseDate: "2026-08-27", articleIds: ["damme:A1"],
};

async function exportOnce(extra: { historicalSheets?: { sheetName: string; rows: unknown[][] }[]; frozen?: unknown[][] } = {}) {
  // A1 wordt geteld (7 × 2 = 14), Q1 (kwartaalartikel) blijft overgenomen (5 × 3 = 15) -> totaal 29.
  const articles = [art("A1"), art("Q1", { countPeriod: "QUARTERLY", rawCountPeriod: "KWARTAAL", previousCount: 5, costPrice: 3 })];
  const entries: CountEntry[] = [
    { id: "e1", sessionId: "s1", articleId: "damme:A1", locationId: "damme:loc-1", quantity: 7, counted: true, countedAt: null, note: null, resolution: "COUNTED" },
  ];
  const review = computeSessionReview(session, [articles[0]!], office.locations, entries);
  const snapshot = buildSessionSnapshot(session, articles, review);
  const out = await new ExcelStockResultExporter().exportResults({
    office, session, review, allArticles: articles, assignments: [], categories: [], snapshot,
    historicalSheets: extra.historicalSheets ?? [],
    historyEntries: buildHistoryEntriesFromSnapshot(snapshot, office.locations),
    frozenSnapshotRows: extra.frozen,
  });
  return { out, snapshot, workbook: XLSX.read(out.data, { type: "array", cellDates: true }) };
}

const rowsOf = (sheet: XLSX.WorkSheet) => XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];

function findCell(sheet: XLSX.WorkSheet, label: string): { r: number; c: number } {
  const range = XLSX.utils.decode_range(sheet["!ref"]!);
  for (let r = range.s.r; r <= range.e.r; r++)
    for (let c = range.s.c; c <= range.e.c; c++) if (sheet[XLSX.utils.encode_cell({ r, c })]?.v === label) return { r, c };
  throw new Error(`label ${label} niet gevonden`);
}

describe("Excel-export: formules en totale stockwaarde", () => {
  it("tellingtabblad: formules per rij en een totalenblok met de volledige voorraadwaarde (ook overgenomen artikelen)", async () => {
    const { workbook } = await exportOnce();
    const sheet = workbook.Sheets["2026-09 Maand"]!;
    const rows = rowsOf(sheet);
    const header = rows[0] as string[];
    const wn = header.indexOf("Waarde nieuwe telling");
    const wp = header.indexOf("Waarde vorige telling");
    expect(wn).toBeGreaterThan(0);
    expect(wp).toBeGreaterThan(0);

    const a1 = XLSX.utils.encode_cell({ r: 1, c: wn });
    expect(sheet[a1]!.f).toContain("*");
    expect(sheet[a1]!.v).toBe(14);

    const label = findCell(sheet, "Totale voorraadwaarde (nieuwe telling)");
    const total = sheet[XLSX.utils.encode_cell({ r: label.r, c: label.c + 1 })]!;
    expect(total.f).toMatch(/^SUM\(/);
    expect(total.v).toBe(29); // 14 (geteld) + 15 (overgenomen)

    const prev = findCell(sheet, "Waarde vorige telling");
    // het header-label staat in rij 1; het totaal-label (zelfde tekst) staat in het blok rechts
    expect(prev).toBeDefined();
    const dv = findCell(sheet, "Totaal verschil bedrag");
    expect(sheet[XLSX.utils.encode_cell({ r: dv.r, c: dv.c + 1 })]!.f).toMatch(/^SUM\(/);
    const cnt = findCell(sheet, "Aantal artikelen");
    expect(sheet[XLSX.utils.encode_cell({ r: cnt.r, c: cnt.c + 1 })]!.v).toBe(2);
  });

  it("TELLING: totalenblok met SUM-formules en verwijzing naar de volledige waarde in het tellingtabblad", async () => {
    const { workbook } = await exportOnce();
    const sheet = workbook.Sheets["TELLING"]!;
    expect(sheet["B10"]!.v).toBe("Totale voorraadwaarde (alle artikelen)");
    expect(sheet["C10"]!.f).toContain("'2026-09 Maand'!");
    expect(sheet["C10"]!.v).toBe(29);
    expect(sheet["C7"]!.f).toMatch(/^SUM\(K15:K16\)/);
    expect(sheet["C8"]!.f).toMatch(/^SUM\(/);
    // rijformule in TELLING: waarde vorige telling = vorige × kostprijs
    expect(sheet["K15"]!.f).toContain("I15");
  });

  it("opnieuw exporteren/doorgeven geeft identieke rijen en nooit dubbele totalenblokken", async () => {
    const first = await exportOnce();
    const frozen = first.out.newHistoricalSheet!.rows;
    const reused = await exportOnce({ frozen });
    expect(rowsOf(reused.workbook.Sheets["2026-09 Maand"]!)).toEqual(rowsOf(first.workbook.Sheets["2026-09 Maand"]!));

    // Het bestand opnieuw inlezen en als historisch tabblad doorgeven (rollend archief).
    const reimported = rowsOf(first.workbook.Sheets["2026-09 Maand"]!);
    const second = await exportOnce({ historicalSheets: [{ sheetName: "2026-08 Maand", rows: reimported }] });
    const passed = second.workbook.Sheets["2026-08 Maand"]!;
    expect(rowsOf(passed)).toEqual(reimported);
    expect(rowsOf(passed).flat().filter((v) => v === "TOTALEN")).toHaveLength(1);
    expect(rowsOf(passed).flat().filter((v) => v === "Totale voorraadwaarde (nieuwe telling)")).toHaveLength(1);
    expect((rowsOf(passed)[0] as unknown[]).filter((v) => v === "Waarde nieuwe telling")).toHaveLength(1);
  });
});
