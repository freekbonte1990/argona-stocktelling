import { describe, expect, it } from "vitest";
import { makeEntry } from "../application/services/centralHistoryTestUtils";
import { legacySessionName } from "./legacyImport";
import {
  buildLegacySnapshotView,
  buildPreviousCountList,
  decodeLegacySnapshotId,
  encodeLegacySnapshotId,
  listLegacySnapshotItems,
} from "./legacySnapshotView";
import { buildLegacyPeriodSnapshot } from "./stockSnapshot";
import type { Article, CountSession } from "./types";

const legacyEntry = (label: string, isoDate: string, qty: number, cost: number | null) =>
  makeEntry({
    sessionName: legacySessionName(label),
    countDate: isoDate,
    totalCount: qty,
    costPrice: cost,
    status: "LEGACY",
    source: "LEGACY_IMPORT",
    sourceSessionId: undefined,
  });

const session = (id: string, startedAt: string): CountSession => ({
  id,
  officeId: "damme",
  type: "MONTHLY",
  status: "COMPLETED",
  startedAt,
  completedAt: startedAt,
  sourceFileName: "x",
  sourceBaseDate: null,
  articleIds: [],
});

describe("legacy snapshot id-schema", () => {
  it("is identiek aan het schema van ComparisonService (legacy:<periode>)", () => {
    expect(encodeLegacySnapshotId("2026-09-01")).toBe("legacy:2026-09-01");
    expect(decodeLegacySnapshotId("legacy:2026-09-01")).toBe("2026-09-01");
    expect(decodeLegacySnapshotId("session-1")).toBeNull();
  });
});

describe("listLegacySnapshotItems", () => {
  it("één item per herkende legacy periode, nieuwste eerst; negeert app-regels en onbekende namen", () => {
    const items = listLegacySnapshotItems([
      legacyEntry("30/06/2025", "2025-06-30", 1, 1),
      legacyEntry("30/06/2025", "2025-06-30", 2, 1),
      legacyEntry("01/09/2026", "2026-09-01", 1, 1),
      makeEntry(),
      { ...legacyEntry("01/09/2026", "2026-09-01", 1, 1), sessionName: "LEGACY onbekend" },
    ]);
    expect(items.map((i) => i.periodLabel)).toEqual(["01/09/2026", "30/06/2025"]);
    expect(items[1].articleCount).toBe(2);
  });
});

describe("buildPreviousCountList", () => {
  it("mengt app + legacy chronologisch (nieuwste eerst); bij gelijke dag staat de echte telling boven de legacy", () => {
    const legacy = listLegacySnapshotItems([
      legacyEntry("01/09/2026", "2026-09-01", 1, 1),
      legacyEntry("30/06/2026", "2026-06-30", 1, 1),
    ]);
    const list = buildPreviousCountList(
      [session("old", "2026-06-01T00:00:00.000Z"), session("same-day", "2026-09-01T00:00:00.000Z"), session("new", "2026-10-06T00:00:00.000Z")],
      legacy,
    );
    expect(list.map((i) => i.id)).toEqual(["new", "same-day", "legacy:2026-09-01", "legacy:2026-06-30", "old"]);
  });
});

describe("buildLegacySnapshotView", () => {
  it("leest enkel de historische hoeveelheid/kostprijs, nooit Article.costPrice; onbekende waarden tellen niet mee", () => {
    const article = (n: string, costPrice: number): Article => ({
      id: `damme:${n}`,
      officeId: "damme",
      articleNumber: n,
      officialArticleNumber: null,
      idType: null,
      description: `Live ${n}`,
      productGroup: null,
      supplier: null,
      unit: null,
      costPrice,
      rawCountPeriod: null,
      countPeriod: "MONTHLY",
      rawStatus: null,
      status: "ACTIVE",
      previousCount: 0,
      sourceRow: 1,
    });
    const entries = [
      { ...legacyEntry("30/06/2025", "2025-06-30", 4, 10), articleId: "damme:A1", articleNumber: "A1" },
      { ...legacyEntry("30/06/2025", "2025-06-30", 5, null), articleId: "damme:A2", articleNumber: "A2" },
    ];
    const articles = new Map([
      ["damme:A1", article("A1", 99999)],
      ["damme:A2", article("A2", 99999)],
    ]);
    const snapshot = buildLegacyPeriodSnapshot("legacy:2025-06-30", "30/06/2025", "2025-06-30", entries, articles);
    const view = buildLegacySnapshotView("damme", "30/06/2025", snapshot, new Map());
    expect(view.totalStockValue).toBe(40);
    expect(view.articlesWithUnknownValue).toBe(1);
    expect(view.articles.find((a) => a.articleNumber === "A2")).toMatchObject({ quantity: 5, costPrice: null, value: null });
    expect(JSON.stringify(view)).not.toContain("99999");
  });
});
