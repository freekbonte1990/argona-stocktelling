import { describe, expect, it } from "vitest";
import type { CentralHistoryFile } from "../src/domain/centralHistoryFile";
import type { SessionCorrectionExport } from "../src/domain/sessionCorrection";
import type { StockHistoryEntry } from "../src/domain/stockSnapshot";
import { applyCorrectionsToCentralHistory, parseCorrectionExport } from "./applyCentralCorrections";

function entry(overrides: Partial<StockHistoryEntry>): StockHistoryEntry {
  return {
    countDate: "2026-10-01",
    sessionType: "QUARTERLY",
    sessionName: "2026-Q3 Kwartaal",
    articleId: "damme:A1",
    articleNumber: "A1",
    description: "A1",
    totalCount: 24,
    previousCount: 25,
    differenceQuantity: -1,
    costPrice: 10,
    differenceAmount: -10,
    status: "GETELD",
    locationNames: [],
    source: "APP",
    ...overrides,
  } as StockHistoryEntry;
}

const history: CentralHistoryFile = {
  schemaVersion: 1,
  officeId: "damme",
  generatedAt: "2026-10-06T00:00:00.000Z",
  deletedSessionIds: [],
  entries: [entry({}), entry({ articleId: "damme:A2", articleNumber: "A2" }), entry({ sessionName: "LEGACY", articleNumber: "A1" })],
};

const correction: SessionCorrectionExport = {
  kind: "argona-session-corrections",
  version: 1,
  officeId: "damme",
  sessionId: "central-x",
  sessionName: "2026-Q3 Kwartaal",
  countDate: "2026-10-01",
  exportedAt: "2026-10-10T00:00:00.000Z",
  corrections: [
    { articleId: "damme:A1", articleNumber: "A1", description: "A1", oldTotalCount: 24, newTotalCount: 30, reason: null, correctedAt: "x" },
    { articleId: "damme:ZZ", articleNumber: "ZZ", description: "ZZ", oldTotalCount: 1, newTotalCount: 2, reason: null, correctedAt: "x" },
  ],
};

describe("applyCorrectionsToCentralHistory", () => {
  it("past enkel de gecorrigeerde regel van die sessie aan en laat de rest ongemoeid", () => {
    const { history: next, report } = applyCorrectionsToCentralHistory(history, correction, "2026-10-11T00:00:00.000Z");
    const a1 = next.entries.find((e) => e.sessionName === "2026-Q3 Kwartaal" && e.articleNumber === "A1")!;
    expect(a1).toMatchObject({ totalCount: 30, differenceQuantity: 5, differenceAmount: 50, costPrice: 10 });
    expect(next.entries.find((e) => e.articleNumber === "A2")!.totalCount).toBe(24);
    expect(next.entries.find((e) => e.sessionName === "LEGACY")!.totalCount).toBe(24);
    expect(report.applied).toHaveLength(1);
    expect(report.notFound).toEqual(["ZZ"]);
    expect(next.generatedAt).toBe("2026-10-11T00:00:00.000Z");
  });

  it("is idempotent en waarschuwt bij een afwijkend centraal origineel", () => {
    const once = applyCorrectionsToCentralHistory(history, correction, "t").history;
    const twice = applyCorrectionsToCentralHistory(once, correction, "t2");
    expect(twice.report.applied).toHaveLength(0);
    expect(twice.report.alreadyApplied).toEqual(["A1"]);
    expect(twice.history.generatedAt).toBe("t");

    const odd = applyCorrectionsToCentralHistory(
      history,
      { ...correction, corrections: [{ ...correction.corrections[0]!, oldTotalCount: 99 }] },
      "t",
    );
    expect(odd.report.mismatches).toHaveLength(1);
  });

  it("weigert een bestand voor een ander kantoor of ongeldig formaat", () => {
    expect(() => applyCorrectionsToCentralHistory(history, { ...correction, officeId: "lokeren" }, "t")).toThrow();
    expect(() => parseCorrectionExport({ kind: "iets" })).toThrow();
  });
});
