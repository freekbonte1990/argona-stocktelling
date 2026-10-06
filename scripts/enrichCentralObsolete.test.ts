import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLegacyStockDamme, parseLegacyStockLokeren } from "../src/adapters/excel/parseLegacyStock";
import { makeMaster, makeMasterArticle } from "../src/application/services/centralMasterTestUtils";
import type { CentralHistoryFile } from "../src/domain/centralHistoryFile";
import type { StockHistoryEntry } from "../src/domain/stockSnapshot";
import { enrichCentralObsolete } from "./enrichCentralObsolete";

const legacyBuffer = (name: string): ArrayBuffer => {
  const b = readFileSync(`test-fixtures/legacy/${name}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe("legacy bronvlag per periode (echte bronbestanden)", () => {
  it("Lokeren: JA* per periode (incl. JA - HUAWEI), NEE overal elders", () => {
    const rows = parseLegacyStockLokeren(legacyBuffer("TGOVL - Stock 01.09.2026 - Telfrequentie.xlsx"), "x.xlsx");
    const ja: Record<string, number> = {};
    for (const r of rows) if (r.obsolete === true) ja[r.periodKey] = (ja[r.periodKey] ?? 0) + 1;
    expect(ja).toEqual({
      "2025-03-31": 50, "2025-06-30": 48, "2025-09-30": 50, "2025-12-31": 26, "2026-03-31": 26, "2026-06-30": 26, "2026-09-01": 26,
    });
    expect(rows.filter((r) => r.obsolete === null)).toHaveLength(0);
  });

  it("Damme: 39 JA vanaf 31/12/2025, ZIE PANELEN en de 2025-periodes zijn onbekend (nooit automatisch obsolete)", () => {
    const rows = parseLegacyStockDamme(legacyBuffer("TGWVL - Stock 31.08.2026 - Telfrequentie.xlsx"), "x.xlsx");
    for (const key of ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-01"]) {
      const p = rows.filter((r) => r.periodKey === key);
      expect(p.filter((r) => r.obsolete === true)).toHaveLength(39);
      expect(p.filter((r) => r.obsolete === null)).toHaveLength(22);
    }
    for (const key of ["2025-03-31", "2025-06-30", "2025-09-30"]) {
      expect(rows.filter((r) => r.periodKey === key).every((r) => r.obsolete === null)).toBe(true);
    }
  });
});

describe("enrichCentralObsolete (eenmalige correctie van de gepubliceerde bestanden)", () => {
  const master = makeMaster({
    officeId: "damme",
    articles: [makeMasterArticle("A1", { rawStatus: "OBSOLETE - ROOD" }), makeMasterArticle("A2", { rawStatus: "NON-ACTIEF" })],
    assignments: [],
  });
  const appEntry = (articleNumber: string): StockHistoryEntry => ({
    countDate: "2026-10-01", sessionType: "QUARTERLY", sessionName: "2026-Q4 Kwartaal", articleId: `damme:${articleNumber}`,
    articleNumber, description: "x", totalCount: 5, previousCount: 4, differenceQuantity: 1, costPrice: 2.5, differenceAmount: 2.5,
    status: "GETELD", locationNames: ["Magazijn"], source: "APP", sourceSessionId: "central-abc",
  });
  const history: CentralHistoryFile = {
    schemaVersion: 1, officeId: "damme", generatedAt: "2026-10-06T00:00:00.000Z", deletedSessionIds: [], entries: [appEntry("A1"), appEntry("A2")],
  } as CentralHistoryFile;

  it("hernoemt enkel sessienaam + classificatie; sessie-ID, datum, hoeveelheden en kostprijzen blijven identiek", () => {
    const { history: out, master: m, report } = enrichCentralObsolete({
      officeId: "damme", master, history, legacyRows: [], generatedAt: "2026-10-07T00:00:00.000Z",
    });
    expect(report.renamedSession).toMatchObject({ from: "2026-Q4 Kwartaal", to: "2026-Q3 Kwartaal", entries: 2, obsolete: 1, active: 1 });
    expect(out.entries.map((e) => e.sessionName)).toEqual(["2026-Q3 Kwartaal", "2026-Q3 Kwartaal"]);
    expect(out.entries.map((e) => e.stockClassification)).toEqual(["OBSOLETE", "ACTIVE"]);
    for (const [i, e] of out.entries.entries()) {
      const { sessionName: _a, stockClassification: _b, ...rest } = e;
      const { sessionName: _c, ...orig } = history.entries[i];
      expect(rest).toEqual(orig);
    }
    expect(m.articles.map((a) => a.stockClassification)).toEqual(["OBSOLETE", undefined]);
    expect(m.revision).not.toBe(master.revision);
  });

  it("weigert te overschrijven als de doelnaam al bestaat", () => {
    const clash = { ...history, entries: [...history.entries, { ...appEntry("A1"), sessionName: "2026-Q3 Kwartaal" }] };
    expect(() => enrichCentralObsolete({ officeId: "damme", master, history: clash, legacyRows: [], generatedAt: "x" })).toThrow();
  });
});
