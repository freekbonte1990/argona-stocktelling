import { describe, expect, it } from "vitest";
import {
  buildNextPreviousCounts,
  computeSessionReview,
  filterReviewResults,
  isSessionReadyToComplete,
} from "./review";
import type { Article, CountEntry, CountSession, Location } from "./types";

const locations: Location[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `office-1:loc-${n}`,
  officeId: "office-1",
  number: n as 1 | 2 | 3 | 4 | 5,
  name: `Locatie ${n}`,
}));

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return {
    id: `office-1:${articleNumber}`,
    officeId: "office-1",
    articleNumber,
    officialArticleNumber: articleNumber,
    idType: "OFFICIEEL",
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "STUKS",
    costPrice: 10,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 5,
    sourceRow: 1,
    ...overrides,
  };
}

function makeEntry(
  articleId: string,
  locationId: string,
  overrides: Partial<CountEntry> = {},
): CountEntry {
  return {
    id: `session-1:${articleId}:${locationId}`,
    sessionId: "session-1",
    articleId,
    locationId,
    quantity: null,
    counted: false,
    countedAt: null,
    note: null,
    ...overrides,
  };
}

function makeSession(articleIds: string[]): Pick<CountSession, "articleIds"> {
  return { articleIds };
}

describe("computeSessionReview", () => {
  it("telt correct over meerdere locaties (totaal = som van alle getelde locaties)", () => {
    const article = makeArticle("A1", { previousCount: 10, costPrice: 2 });
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 3, counted: true }),
      makeEntry("office-1:A1", "office-1:loc-3", { quantity: 4, counted: true }),
    ];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    const result = review.results[0];
    expect(result.fullyCounted).toBe(true);
    expect(result.newTotalCount).toBe(7);
    expect(result.differenceQuantity).toBe(-3); // 7 - 10
    expect(result.differenceAmount).toBe(-6); // -3 * 2
  });

  it("behandelt een expliciete 0 als geldig geteld, niet als ontbrekend", () => {
    const article = makeArticle("A1", { previousCount: 5 });
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    const result = review.results[0];
    expect(result.fullyCounted).toBe(true);
    expect(result.newTotalCount).toBe(0);
    expect(result.differenceQuantity).toBe(-5);
  });

  it("interpreteert niet-geteld NOOIT als 0 — newTotalCount/verschil blijven null", () => {
    const article = makeArticle("A1", { previousCount: 5 });
    // Geen entries op dit artikel: nog nooit geteld.
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, []);
    const result = review.results[0];
    expect(result.fullyCounted).toBe(false);
    expect(result.newTotalCount).toBeNull();
    expect(result.differenceQuantity).toBeNull();
    expect(result.differenceAmount).toBeNull();
    expect(review.notCountedArticles).toBe(1);
    expect(review.countedArticles).toBe(0);
  });

  it("een artikel dat op één locatie geteld is maar op een andere nog niet, blijft 'niet volledig geteld'", () => {
    const article = makeArticle("A1");
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 3, counted: true }),
      makeEntry("office-1:A1", "office-1:loc-2", { quantity: null, counted: false }),
    ];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    const result = review.results[0];
    expect(result.fullyCounted).toBe(false);
    expect(result.newTotalCount).toBeNull();
    expect(review.notCountedArticles).toBe(1);
  });

  it("berekent verschil aantal en verschil euro correct, ook bij een negatieve correctie", () => {
    const article = makeArticle("A1", { previousCount: 20, costPrice: 3.5 });
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 12, counted: true })];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    const result = review.results[0];
    expect(result.differenceQuantity).toBe(-8);
    expect(result.differenceAmount).toBeCloseTo(-28);
    expect(review.totalNegativeCorrectionQuantity).toBe(-8);
    expect(review.totalNegativeCorrectionAmount).toBeCloseTo(-28);
    expect(review.totalPositiveCorrectionQuantity).toBe(0);
  });

  it("telt positieve en negatieve correcties apart op over meerdere artikelen", () => {
    const a1 = makeArticle("A1", { previousCount: 5, costPrice: 1 });
    const a2 = makeArticle("A2", { previousCount: 5, costPrice: 2 });
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 8, counted: true }), // +3
      makeEntry("office-1:A2", "office-1:loc-1", { quantity: 1, counted: true }), // -4
    ];
    const review = computeSessionReview(makeSession(["office-1:A1", "office-1:A2"]), [a1, a2], locations, entries);
    expect(review.totalPositiveCorrectionQuantity).toBe(3);
    expect(review.totalNegativeCorrectionQuantity).toBe(-4);
    expect(review.totalPositiveCorrectionAmount).toBeCloseTo(3);
    expect(review.totalNegativeCorrectionAmount).toBeCloseTo(-8);
    expect(review.articlesWithDifference).toBe(2);
  });

  it("een artikel zonder verschil (nieuwe telling == vorige telling) telt niet mee als 'verschil'", () => {
    const article = makeArticle("A1", { previousCount: 5 });
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 5, counted: true })];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    expect(review.articlesWithDifference).toBe(0);
    expect(review.results[0].differenceQuantity).toBe(0);
  });

  it("neemt handmatige buiten-scope-toevoegingen mee in de resultatenlijst, maar niet in de scope-totalen", () => {
    const scopeArticle = makeArticle("A1");
    const manualArticle = makeArticle("Q1", { countPeriod: "QUARTERLY", rawCountPeriod: "KWARTAAL" });
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 5, counted: true }),
      makeEntry("office-1:Q1", "office-1:loc-2", {
        quantity: 2,
        counted: true,
        note: "Buiten sessiescope: handmatig toegevoegd tijdens maandtelling.",
      }),
    ];
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [scopeArticle, manualArticle],
      locations,
      entries,
    );
    expect(review.totalArticlesInScope).toBe(1);
    expect(review.results).toHaveLength(2);
    const manualResult = review.results.find((r) => r.articleId === "office-1:Q1");
    expect(manualResult?.isManualAddition).toBe(true);
    expect(manualResult?.flaggedForControl).toBe(true);
  });

  it("markeert enkel artikelen met een notitie als 'Controle'", () => {
    const a1 = makeArticle("A1");
    const a2 = makeArticle("A2");
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 5, counted: true, note: "twijfelgeval" }),
      makeEntry("office-1:A2", "office-1:loc-1", { quantity: 5, counted: true }),
    ];
    const review = computeSessionReview(makeSession(["office-1:A1", "office-1:A2"]), [a1, a2], locations, entries);
    const controlResults = filterReviewResults(review.results, "CONTROL");
    expect(controlResults.map((r) => r.articleId)).toEqual(["office-1:A1"]);
  });
});

describe("filterReviewResults", () => {
  const article = makeArticle("A1", { previousCount: 5 });
  const notCountedArticle = makeArticle("A2", { previousCount: 5 });
  const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 8, counted: true })];
  const review = computeSessionReview(
    makeSession(["office-1:A1", "office-1:A2"]),
    [article, notCountedArticle],
    locations,
    entries,
  );

  it("ALL geeft alles terug", () => {
    expect(filterReviewResults(review.results, "ALL")).toHaveLength(2);
  });

  it("DIFFERENCE geeft enkel artikelen met een verschil terug", () => {
    const filtered = filterReviewResults(review.results, "DIFFERENCE");
    expect(filtered.map((r) => r.articleId)).toEqual(["office-1:A1"]);
  });

  it("NOT_COUNTED geeft enkel niet volledig getelde artikelen terug", () => {
    const filtered = filterReviewResults(review.results, "NOT_COUNTED");
    expect(filtered.map((r) => r.articleId)).toEqual(["office-1:A2"]);
  });
});

describe("isSessionReadyToComplete", () => {
  it("false wanneer er nog niet-getelde artikelen zijn", () => {
    const article = makeArticle("A1");
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, []);
    expect(isSessionReadyToComplete(review)).toBe(false);
  });

  it("true wanneer alle scope-artikelen volledig geteld zijn", () => {
    const article = makeArticle("A1");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    expect(isSessionReadyToComplete(review)).toBe(true);
  });

  it("blijft true als enkel een buiten-scope-toevoeging niet meetelt (die blokkeert nooit)", () => {
    const scopeArticle = makeArticle("A1");
    const manualArticle = makeArticle("Q1");
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true }),
      makeEntry("office-1:Q1", "office-1:loc-2", { quantity: 1, counted: true }),
    ];
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [scopeArticle, manualArticle],
      locations,
      entries,
    );
    expect(isSessionReadyToComplete(review)).toBe(true);
  });
});

describe("buildNextPreviousCounts", () => {
  it("gebruikt de nieuwe totale telling voor geteld artikelen, en behoudt de oude previousCount voor de rest", () => {
    const countedArticle = makeArticle("A1", { previousCount: 5 });
    const skippedArticle = makeArticle("Q1", { previousCount: 42, countPeriod: "QUARTERLY" });
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 9, counted: true })];
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [countedArticle, skippedArticle],
      locations,
      entries,
    );
    const next = buildNextPreviousCounts([countedArticle, skippedArticle], review.results);
    expect(next.get("office-1:A1")).toBe(9);
    expect(next.get("office-1:Q1")).toBe(42);
  });

  it("behoudt de oude previousCount voor een artikel dat niet volledig geteld werd", () => {
    const article = makeArticle("A1", { previousCount: 7 });
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 1, counted: true }),
      makeEntry("office-1:A1", "office-1:loc-2", { quantity: null, counted: false }),
    ];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    const next = buildNextPreviousCounts([article], review.results);
    expect(next.get("office-1:A1")).toBe(7);
  });
});
