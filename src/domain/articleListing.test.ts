import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARTICLE_LIST_FILTERS,
  countActiveArticleListFilters,
  filterArticlesForList,
  sortArticlesForList,
} from "./articleListing";
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

describe("sortArticlesForList (v0.2.1 §5, Artikels-overzicht)", () => {
  const a1 = makeArticle({ articleNumber: "A1", description: "Zaagblad", productGroup: "Gereedschap" });
  const a2 = makeArticle({ articleNumber: "A2", description: "Boormachine", productGroup: "Gereedschap" });
  const a3 = makeArticle({ articleNumber: "A3", description: "Fietsbel", productGroup: "Accessoires" });
  const a10 = makeArticle({ articleNumber: "A10", description: "Kettingslot", productGroup: "Accessoires" });

  it("sorteert standaard op Productgroep → Omschrijving", () => {
    const sorted = sortArticlesForList([a1, a2, a3, a10], "GROUP_THEN_DESCRIPTION");
    expect(sorted.map((a) => a.articleNumber)).toEqual(["A3", "A10", "A2", "A1"]);
  });

  it("Omschrijving A-Z en Z-A", () => {
    const asc = sortArticlesForList([a1, a2, a3, a10], "DESCRIPTION_ASC");
    expect(asc.map((a) => a.description)).toEqual(["Boormachine", "Fietsbel", "Kettingslot", "Zaagblad"]);

    const desc = sortArticlesForList([a1, a2, a3, a10], "DESCRIPTION_DESC");
    expect(desc.map((a) => a.description)).toEqual(["Zaagblad", "Kettingslot", "Fietsbel", "Boormachine"]);
  });

  it("Artikelnummer, numeriek (A2 vóór A10)", () => {
    const sorted = sortArticlesForList([a10, a2], "ARTICLE_NUMBER");
    expect(sorted.map((a) => a.articleNumber)).toEqual(["A2", "A10"]);
  });

  it("Telfrequentie: MAAND vóór KWARTAAL vóór JAAR", () => {
    const monthly = makeArticle({ articleNumber: "M", countPeriod: "MONTHLY" });
    const quarterly = makeArticle({ articleNumber: "Q", countPeriod: "QUARTERLY" });
    const yearly = makeArticle({ articleNumber: "Y", countPeriod: "YEARLY" });
    const sorted = sortArticlesForList([yearly, monthly, quarterly], "COUNT_PERIOD");
    expect(sorted.map((a) => a.articleNumber)).toEqual(["M", "Q", "Y"]);
  });

  it("Vorige telling: hoogste eerst, nooit-geteld (null) laatst", () => {
    const high = makeArticle({ articleNumber: "H", previousCount: 50 });
    const low = makeArticle({ articleNumber: "L", previousCount: 3 });
    const unknown = makeArticle({ articleNumber: "U", previousCount: null });
    const sorted = sortArticlesForList([low, unknown, high], "PREVIOUS_COUNT");
    expect(sorted.map((a) => a.articleNumber)).toEqual(["H", "L", "U"]);
  });
});

describe("filterArticlesForList (v0.2.1 §6)", () => {
  const battery = makeArticle({
    articleNumber: "BAT1",
    description: "Batterij pack",
    productGroup: "Batterijen",
    countPeriod: "MONTHLY",
    status: "ACTIVE",
  });
  const tool = makeArticle({
    articleNumber: "TOOL1",
    description: "Boormachine",
    productGroup: "Gereedschap",
    countPeriod: "YEARLY",
    status: "ACTIVE",
  });
  const inactive = makeArticle({
    articleNumber: "OLD1",
    description: "Verouderd onderdeel",
    productGroup: "Batterijen",
    countPeriod: "MONTHLY",
    status: "INACTIVE",
  });

  const articles = [battery, tool, inactive];

  it("zonder filters komt alles terug", () => {
    const result = filterArticlesForList(articles, DEFAULT_ARTICLE_LIST_FILTERS, new Map());
    expect(result).toHaveLength(3);
  });

  it("filtert op productgroep", () => {
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, productGroup: "Batterijen" },
      new Map(),
    );
    expect(result.map((a) => a.articleNumber).sort()).toEqual(["BAT1", "OLD1"]);
  });

  it("filtert op telfrequentie", () => {
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, countPeriod: "YEARLY" },
      new Map(),
    );
    expect(result.map((a) => a.articleNumber)).toEqual(["TOOL1"]);
  });

  it("filtert op artikelstatus", () => {
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, status: "INACTIVE" },
      new Map(),
    );
    expect(result.map((a) => a.articleNumber)).toEqual(["OLD1"]);
  });

  it("'Geen locatie' toont enkel artikelen zonder actieve locatiekoppeling", () => {
    const locationIdsByArticle = new Map<string, Set<string>>([["office-1:BAT1", new Set(["loc-1"])]]);
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, location: "NONE" },
      locationIdsByArticle,
    );
    expect(result.map((a) => a.articleNumber).sort()).toEqual(["OLD1", "TOOL1"]);
  });

  it("filtert op een specifieke locatie", () => {
    const locationIdsByArticle = new Map<string, Set<string>>([
      ["office-1:BAT1", new Set(["loc-1"])],
      ["office-1:TOOL1", new Set(["loc-2"])],
    ]);
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, location: "loc-1" },
      locationIdsByArticle,
    );
    expect(result.map((a) => a.articleNumber)).toEqual(["BAT1"]);
  });

  it("zoekterm combineert met filters", () => {
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, productGroup: "Batterijen", search: "pack" },
      new Map(),
    );
    expect(result.map((a) => a.articleNumber)).toEqual(["BAT1"]);
  });
});

describe("countActiveArticleListFilters (v0.2.1 correctieronde §1: 'Filters (N)')", () => {
  it("telt 0 bij de standaardfilters", () => {
    expect(countActiveArticleListFilters(DEFAULT_ARTICLE_LIST_FILTERS)).toBe(0);
  });

  it("telt elk afzonderlijk aangepast filterveld, maar niet de zoekterm", () => {
    expect(
      countActiveArticleListFilters({
        ...DEFAULT_ARTICLE_LIST_FILTERS,
        productGroup: "Batterijen",
        location: "NONE",
        search: "iets",
      }),
    ).toBe(2);
  });

  it("combineert meerdere filters correct tot 4", () => {
    expect(
      countActiveArticleListFilters({
        search: "",
        productGroup: "Batterijen",
        countPeriod: "MONTHLY",
        status: "ACTIVE",
        location: "loc-1",
      }),
    ).toBe(4);
  });
});
