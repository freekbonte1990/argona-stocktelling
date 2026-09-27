import { describe, expect, it } from "vitest";
import { selectArticlesForNewCount } from "./countScope";
import type { Article } from "./types";

function makeArticle(overrides: Partial<Article> & Pick<Article, "id" | "officeId" | "articleNumber">): Article {
  return {
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: null,
    supplier: null,
    unit: null,
    costPrice: null,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: null,
    sourceRow: null,
    ...overrides,
  };
}

describe("selectArticlesForNewCount (Sprint 3.3 §2: gecentraliseerde count-scope-regel)", () => {
  it("sluit een artikel dat inactief is in het assortiment uit, ook al past het bij de telfrequentie", () => {
    const active = makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", countPeriod: "MONTHLY" });
    const historicalOnly = makeArticle({
      id: "a:2",
      officeId: "a",
      articleNumber: "2",
      countPeriod: "MONTHLY",
      assortmentActive: false,
    });
    const scope = selectArticlesForNewCount([active, historicalOnly], "MONTHLY");
    expect(scope.map((a) => a.id)).toEqual(["a:1"]);
  });

  it("een historisch-alleen artikel wordt nooit meegenomen, ook niet bij een VOLLEDIGE telling (FULL)", () => {
    const historicalOnly = makeArticle({
      id: "a:1",
      officeId: "a",
      articleNumber: "1",
      countPeriod: "YEARLY",
      assortmentActive: false,
    });
    expect(selectArticlesForNewCount([historicalOnly], "FULL")).toHaveLength(0);
  });

  it("hetzelfde artikelnummer kan actief zijn in kantoor A en inactief in kantoor B — elk Article-record heeft zijn eigen assortmentActive", () => {
    const officeA = makeArticle({ id: "a:LP1", officeId: "a", articleNumber: "LP1", assortmentActive: true });
    const officeB = makeArticle({ id: "b:LP1", officeId: "b", articleNumber: "LP1", assortmentActive: false });
    expect(selectArticlesForNewCount([officeA], "MONTHLY").map((a) => a.id)).toEqual(["a:LP1"]);
    expect(selectArticlesForNewCount([officeB], "MONTHLY")).toHaveLength(0);
  });

  it("blijft de bestaande telfrequentie-regel toepassen (nooit een kwartaalartikel in een maandtelling)", () => {
    const quarterly = makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", countPeriod: "QUARTERLY" });
    expect(selectArticlesForNewCount([quarterly], "MONTHLY")).toHaveLength(0);
    expect(selectArticlesForNewCount([quarterly], "QUARTERLY").map((a) => a.id)).toEqual(["a:1"]);
  });
});
