import { describe, expect, it } from "vitest";
import { sortArticlesForLocation } from "./sorting";
import type { Article } from "./types";

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: null,
    description: "Omschrijving",
    productGroup: null,
    supplier: null,
    unit: "stuk",
    costPrice: 1,
    rawCountPeriod: null,
    countPeriod: "MONTHLY",
    rawStatus: null,
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
    ...overrides,
  };
}

describe("sortArticlesForLocation (spec v0.2.1 §2, §9)", () => {
  const a1 = makeArticle({ articleNumber: "A1", description: "Zaagblad", productGroup: "Gereedschap" });
  const a2 = makeArticle({ articleNumber: "A2", description: "Boormachine", productGroup: "Gereedschap" });
  const a3 = makeArticle({ articleNumber: "A3", description: "Fietsbel", productGroup: "Accessoires" });
  const a10 = makeArticle({ articleNumber: "A10", description: "Kettingslot", productGroup: "Accessoires" });

  it("sorteert standaard op Productgroep -> Omschrijving", () => {
    const sorted = sortArticlesForLocation([a1, a2, a3, a10], new Set());
    // Accessoires (A3 "Fietsbel", A10 "Kettingslot") komt vóór Gereedschap
    // (A2 "Boormachine", A1 "Zaagblad"); binnen elke groep op omschrijving.
    expect(sorted.map((a) => a.articleNumber)).toEqual(["A3", "A10", "A2", "A1"]);
  });

  it("sorteert op enkel Omschrijving wanneer die modus gekozen is", () => {
    const sorted = sortArticlesForLocation([a1, a2, a3, a10], new Set(), "DESCRIPTION");
    expect(sorted.map((a) => a.description)).toEqual(
      [...[a1, a2, a3, a10].map((a) => a.description)].sort((x, y) => x.localeCompare(y, "nl")),
    );
  });

  it("sorteert op Artikelnummer (numeriek: A2 < A10) wanneer die modus gekozen is", () => {
    const sorted = sortArticlesForLocation([a10, a2, a1, a3], new Set(), "ARTICLE_NUMBER");
    expect(sorted.map((a) => a.articleNumber)).toEqual(["A1", "A2", "A3", "A10"]);
  });

  it("plaatst verwachte artikelen altijd eerst, ongeacht de gekozen sorteermodus", () => {
    const expected = new Set([a1.id]);
    const sorted = sortArticlesForLocation([a2, a3, a10, a1], expected, "ARTICLE_NUMBER");
    expect(sorted[0].id).toBe(a1.id);
    // binnen de "niet-verwacht" tier blijft de gekozen modus gelden
    expect(sorted.slice(1).map((a) => a.articleNumber)).toEqual(["A2", "A3", "A10"]);
  });

  it("gebruikt Productgroep -> Omschrijving wanneer geen modus is opgegeven (backward compatible)", () => {
    const sorted = sortArticlesForLocation([a1, a2], new Set());
    expect(sorted.map((a) => a.articleNumber)).toEqual(["A2", "A1"]); // Boormachine < Zaagblad
  });
});
