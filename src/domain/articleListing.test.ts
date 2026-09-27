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

/** Sprint 3.2 §9: sortering/filtering werkt sinds deze sprint op de canonieke Productgamma (`categoryId`), nooit meer op de bevroren `productGroup`. */
const GEREEDSCHAP = "cat-gereedschap";
const ACCESSOIRES = "cat-accessoires";
const BATTERIJEN = "cat-batterijen";
const CATEGORY_NAME_BY_ID = new Map<string, string>([
  [GEREEDSCHAP, "Gereedschap"],
  [ACCESSOIRES, "Accessoires"],
  [BATTERIJEN, "Batterijen"],
]);

describe("sortArticlesForList (v0.2.1 §5, Artikels-overzicht; Sprint 3.2 §9: op canonieke Productgamma)", () => {
  const a1 = makeArticle({ articleNumber: "A1", description: "Zaagblad", categoryId: GEREEDSCHAP });
  const a2 = makeArticle({ articleNumber: "A2", description: "Boormachine", categoryId: GEREEDSCHAP });
  const a3 = makeArticle({ articleNumber: "A3", description: "Fietsbel", categoryId: ACCESSOIRES });
  const a10 = makeArticle({ articleNumber: "A10", description: "Kettingslot", categoryId: ACCESSOIRES });

  it("sorteert standaard op Productgamma → Omschrijving", () => {
    const sorted = sortArticlesForList([a1, a2, a3, a10], "GROUP_THEN_DESCRIPTION", CATEGORY_NAME_BY_ID);
    expect(sorted.map((a) => a.articleNumber)).toEqual(["A3", "A10", "A2", "A1"]);
  });

  it("zonder categoryNameById-map valt elk artikel terug op dezelfde fallback-groep (nooit een crash)", () => {
    const sorted = sortArticlesForList([a1, a3], "GROUP_THEN_DESCRIPTION");
    // Beide vallen terug op "Niet ingedeeld" -> sortering degradeert naar Omschrijving.
    expect(sorted.map((a) => a.description)).toEqual(["Fietsbel", "Zaagblad"]);
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

describe("filterArticlesForList (v0.2.1 §6; Sprint 3.2 §9: filtert op canonieke Productgamma, met expliciet 'niet ingedeeld' filter)", () => {
  const battery = makeArticle({
    articleNumber: "BAT1",
    description: "Batterij pack",
    categoryId: BATTERIJEN,
    countPeriod: "MONTHLY",
    status: "ACTIVE",
  });
  const tool = makeArticle({
    articleNumber: "TOOL1",
    description: "Boormachine",
    categoryId: GEREEDSCHAP,
    countPeriod: "YEARLY",
    status: "ACTIVE",
  });
  const inactive = makeArticle({
    articleNumber: "OLD1",
    description: "Verouderd onderdeel",
    categoryId: BATTERIJEN,
    countPeriod: "MONTHLY",
    status: "INACTIVE",
  });
  const unclassified = makeArticle({
    articleNumber: "NEW1",
    description: "Nog niet ingedeeld onderdeel",
    categoryId: null,
    countPeriod: "MONTHLY",
    status: "ACTIVE",
  });

  const articles = [battery, tool, inactive, unclassified];

  it("zonder filters komt alles terug", () => {
    const result = filterArticlesForList(articles, DEFAULT_ARTICLE_LIST_FILTERS, new Map());
    expect(result).toHaveLength(4);
  });

  it("filtert op een specifieke productgamma", () => {
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, category: BATTERIJEN },
      new Map(),
    );
    expect(result.map((a) => a.articleNumber).sort()).toEqual(["BAT1", "OLD1"]);
  });

  it("filtert op 'niet ingedeeld' (spec §9: mag nooit verborgen worden, enkel expliciet filterbaar)", () => {
    const result = filterArticlesForList(
      articles,
      { ...DEFAULT_ARTICLE_LIST_FILTERS, category: "UNCLASSIFIED" },
      new Map(),
    );
    expect(result.map((a) => a.articleNumber)).toEqual(["NEW1"]);
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
    expect(result.map((a) => a.articleNumber).sort()).toEqual(["NEW1", "OLD1", "TOOL1"]);
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
      { ...DEFAULT_ARTICLE_LIST_FILTERS, category: BATTERIJEN, search: "pack" },
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
        category: BATTERIJEN,
        location: "NONE",
        search: "iets",
      }),
    ).toBe(2);
  });

  it("combineert meerdere filters correct tot 4", () => {
    expect(
      countActiveArticleListFilters({
        search: "",
        category: BATTERIJEN,
        countPeriod: "MONTHLY",
        status: "ACTIVE",
        location: "loc-1",
        assortment: "ALL",
      }),
    ).toBe(4);
  });
});
