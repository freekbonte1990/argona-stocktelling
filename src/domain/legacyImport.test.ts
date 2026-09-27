import { describe, expect, it } from "vitest";
import {
  buildCurrentArticleIndexes,
  buildLegacyImportPlan,
  buildLegacyOnlyArticle,
  matchLegacyRow,
  normalizeDescriptionForMatching,
  type LegacyStockRow,
} from "./legacyImport";
import { LEGACY_PERIOD_BY_KEY, normalizeQuarterLabelToPeriodKey } from "./legacyPeriods";
import type { Article } from "./types";

function makeArticle(overrides: Partial<Article> & Pick<Article, "id" | "officeId" | "articleNumber">): Article {
  return {
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: null,
    supplier: null,
    unit: null,
    costPrice: 1,
    rawCountPeriod: null,
    countPeriod: "MONTHLY",
    rawStatus: null,
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<LegacyStockRow>): LegacyStockRow {
  return {
    periodKey: "2025-03-31",
    sourceProductGroup: "Batterijen",
    description: "Testartikel",
    articleNumber: "BATT001",
    originalCostPrice: 10,
    quantity: 5,
    obsolete: false,
    sourceRef: "TEST!A1",
    ...overrides,
  };
}

describe("normalizeQuarterLabelToPeriodKey (Sprint 3.3 §3)", () => {
  it("herkent gangbare varianten (met/zonder spatie, aaneengeschreven)", () => {
    expect(normalizeQuarterLabelToPeriodKey("Q1 2025")).toBe("2025-03-31");
    expect(normalizeQuarterLabelToPeriodKey("Q12025")).toBe("2025-03-31");
    expect(normalizeQuarterLabelToPeriodKey("q2 2026")).toBe("2026-06-30");
    expect(normalizeQuarterLabelToPeriodKey("Q4 2025")).toBe("2025-12-31");
  });

  it("geeft null voor onherkenbare tekst", () => {
    expect(normalizeQuarterLabelToPeriodKey("01 09 2026")).toBeNull();
    expect(normalizeQuarterLabelToPeriodKey(null)).toBeNull();
    expect(normalizeQuarterLabelToPeriodKey(undefined)).toBeNull();
  });

  it("alle 7 vereiste periodes zijn geregistreerd", () => {
    expect(LEGACY_PERIOD_BY_KEY.size).toBe(7);
    expect(LEGACY_PERIOD_BY_KEY.get("2026-09-01")?.label).toBe("01/09/2026");
  });
});

describe("matchLegacyRow (Sprint 3.3 §3: matching-prioriteit)", () => {
  const current = [
    makeArticle({ id: "lokeren:BATT001", officeId: "lokeren", articleNumber: "BATT001", description: "Huidig artikel" }),
    makeArticle({ id: "lokeren:BATT002", officeId: "lokeren", articleNumber: "BATT002", description: "Zonnepaneel X" }),
  ];
  const { byNumber, byNormalizedDescription } = buildCurrentArticleIndexes(current);

  it("prioriteit 1: een aanwezig artikelnummer matcht altijd op nummer, ook als het huidige artikel niet exact hetzelfde is", () => {
    const result = matchLegacyRow({ articleNumber: "BATT001", description: "Andere oude naam" }, "lokeren", byNumber, byNormalizedDescription);
    expect(result.method).toBe("ARTICLE_NUMBER");
    expect(result.matchedArticle?.id).toBe("lokeren:BATT001");
    expect(result.resolvedArticleId).toBe("lokeren:BATT001");
  });

  it("een artikelnummer dat niet meer in het huidige mastermodel voorkomt is GEEN onopgeloste rij — blijft herkenbaar op zijn eigen nummer", () => {
    const result = matchLegacyRow({ articleNumber: "OLD999", description: "Uitgefaseerd" }, "lokeren", byNumber, byNormalizedDescription);
    expect(result.method).toBe("ARTICLE_NUMBER");
    expect(result.matchedArticle).toBeNull();
    expect(result.resolvedArticleId).toBe("lokeren:OLD999");
  });

  it("prioriteit 2: zonder artikelnummer valt terug op genormaliseerde exacte omschrijving", () => {
    const result = matchLegacyRow({ articleNumber: null, description: "  Zonnepaneel X  " }, "lokeren", byNumber, byNormalizedDescription);
    expect(result.method).toBe("NORMALIZED_DESCRIPTION");
    expect(result.matchedArticle?.id).toBe("lokeren:BATT002");
  });

  it("prioriteit 3: zonder nummer en zonder omschrijvingsmatch is de rij onopgelost, met een stabiele gesynthetiseerde identiteit", () => {
    const result = matchLegacyRow({ articleNumber: null, description: "Iets nooit eerder gezien" }, "lokeren", byNumber, byNormalizedDescription);
    expect(result.method).toBe("UNRESOLVED");
    expect(result.matchedArticle).toBeNull();
    expect(result.resolvedArticleId).toBe("lokeren:LEGACY-iets-nooit-eerder-gezien");

    // Idempotent: exact dezelfde rij levert exact hetzelfde ID op.
    const again = matchLegacyRow({ articleNumber: null, description: "Iets nooit eerder gezien" }, "lokeren", byNumber, byNormalizedDescription);
    expect(again.resolvedArticleId).toBe(result.resolvedArticleId);
  });

  it("nooit fuzzy: een gedeeltelijke tekstovereenkomst matcht niet", () => {
    const result = matchLegacyRow({ articleNumber: null, description: "Zonnepaneel" }, "lokeren", byNumber, byNormalizedDescription);
    expect(result.method).toBe("UNRESOLVED");
  });
});

describe("buildLegacyOnlyArticle (spec: oude artikelen blijven importeerbaar als historisch/inactief)", () => {
  it("bouwt een inactief, niet-in-assortiment artikel voor een onopgeloste/niet-matchende rij", () => {
    const row = makeRow({ articleNumber: "OLD999", description: "Uitgefaseerd", originalCostPrice: 42 });
    const match = matchLegacyRow(row, "lokeren", new Map(), new Map());
    const article = buildLegacyOnlyArticle(row, "lokeren", match);
    expect(article).not.toBeNull();
    expect(article?.id).toBe("lokeren:OLD999");
    expect(article?.status).toBe("INACTIVE");
    expect(article?.assortmentActive).toBe(false);
    expect(article?.costPrice).toBe(42);
    expect(article?.countPeriod).toBe("NOT_APPLICABLE");
  });

  it("geeft null terug wanneer de rij al matchte met een bestaand levend artikel — dat artikel wordt nooit overschreven", () => {
    const current = [makeArticle({ id: "lokeren:BATT001", officeId: "lokeren", articleNumber: "BATT001" })];
    const { byNumber, byNormalizedDescription } = buildCurrentArticleIndexes(current);
    const row = makeRow({ articleNumber: "BATT001" });
    const match = matchLegacyRow(row, "lokeren", byNumber, byNormalizedDescription);
    expect(buildLegacyOnlyArticle(row, "lokeren", match)).toBeNull();
  });
});

describe("buildLegacyImportPlan (Sprint 3.3 §3: volledig importplan + preview/report)", () => {
  it("bouwt correcte periode-statistieken, matched/unresolved-tellingen en de oorspronkelijke totale stockwaarde", () => {
    const rows: LegacyStockRow[] = [
      makeRow({ periodKey: "2025-03-31", articleNumber: "BATT001", quantity: 10, originalCostPrice: 5 }), // matched
      makeRow({ periodKey: "2025-03-31", articleNumber: "OLD999", quantity: 3, originalCostPrice: 20 }), // article-number, no current match -> new legacy article
      makeRow({ periodKey: "2025-03-31", articleNumber: null, description: "Nooit gezien", quantity: 1, originalCostPrice: 2 }), // unresolved
    ];
    const current = [makeArticle({ id: "lokeren:BATT001", officeId: "lokeren", articleNumber: "BATT001" })];

    const plan = buildLegacyImportPlan(rows, "lokeren", LEGACY_PERIOD_BY_KEY, current);

    expect(plan.preview.totalRows).toBe(3);
    expect(plan.preview.totalMatched).toBe(2); // BATT001 (by number) + OLD999 (by number, no match maar wel method ARTICLE_NUMBER telt mee als "matched")
    expect(plan.preview.totalUnresolved).toBe(1);
    expect(plan.preview.totalOriginalStockValue).toBe(10 * 5 + 3 * 20 + 1 * 2);

    const period = plan.preview.periods.find((p) => p.periodKey === "2025-03-31");
    expect(period?.rowCount).toBe(3);
    expect(period?.periodLabel).toBe("31/03/2025");

    // Enkel OLD999 en de onopgeloste rij leveren een NIEUW artikel op — BATT001 bestond al.
    expect(plan.newArticles.map((a) => a.id).sort()).toEqual([
      "lokeren:LEGACY-nooit-gezien",
      "lokeren:OLD999",
    ]);

    expect(plan.historyEntries).toHaveLength(3);
    expect(plan.historyEntries.every((e) => e.status === "LEGACY" && e.source === "LEGACY_IMPORT")).toBe(true);
    expect(plan.historyEntries.every((e) => e.sessionName === "LEGACY 31/03/2025")).toBe(true);
  });

  it("markeert ontbrekende hoeveelheid/kostprijs en negatieve hoeveelheid als anomalie, zonder de rij te blokkeren", () => {
    const rows: LegacyStockRow[] = [
      makeRow({ quantity: null }),
      makeRow({ originalCostPrice: null, articleNumber: "X2" }),
      makeRow({ quantity: -5, articleNumber: "X3" }),
    ];
    const plan = buildLegacyImportPlan(rows, "lokeren", LEGACY_PERIOD_BY_KEY, []);
    expect(plan.preview.anomalies.length).toBeGreaterThanOrEqual(3);
    expect(plan.preview.totalRows).toBe(3); // geen enkele rij overgeslagen
  });

  it("is idempotent: twee keer hetzelfde plan bouwen uit dezelfde rijen levert identieke artikel-ID's/HISTORIE-sleutels op", () => {
    const rows: LegacyStockRow[] = [makeRow({ articleNumber: null, description: "Onbekend artikel" })];
    const planA = buildLegacyImportPlan(rows, "lokeren", LEGACY_PERIOD_BY_KEY, []);
    const planB = buildLegacyImportPlan(rows, "lokeren", LEGACY_PERIOD_BY_KEY, []);
    expect(planA.newArticles.map((a) => a.id)).toEqual(planB.newArticles.map((a) => a.id));
    expect(planA.historyEntries.map((e) => e.articleId)).toEqual(planB.historyEntries.map((e) => e.articleId));
  });
});

describe("normalizeDescriptionForMatching", () => {
  it("trimt en normaliseert whitespace/hoofdletters", () => {
    expect(normalizeDescriptionForMatching("  Zonnepaneel   X  ")).toBe("zonnepaneel x");
  });
});
