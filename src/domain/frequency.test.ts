import { describe, expect, it } from "vitest";
import {
  articlesNeedingReview,
  computeFrequencyBreakdown,
  normalizeArticleStatus,
  normalizeFrequency,
  selectArticlesForSessionType,
} from "./frequency";
import type { Article } from "./types";

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: overrides.id ?? "office:ART-1",
    officeId: "office",
    articleNumber: "ART-1",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: "GROEP-A",
    supplier: null,
    unit: "stuk",
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
    ...overrides,
  };
}

describe("normalizeFrequency", () => {
  it.each([
    ["MAAND", "MONTHLY"],
    ["maand", "MONTHLY"],
    ["  Maand ", "MONTHLY"],
    ["KWARTAAL", "QUARTERLY"],
    ["JAAR", "YEARLY"],
    ["NVT", "NOT_APPLICABLE"],
    ["NOG TE BEPALEN", "TO_BE_DETERMINED"],
    ["", "TO_BE_DETERMINED"],
    [null, "TO_BE_DETERMINED"],
    [undefined, "TO_BE_DETERMINED"],
    ["iets onbekends", "TO_BE_DETERMINED"],
  ])("normalizeFrequency(%s) => %s", (raw, expected) => {
    expect(normalizeFrequency(raw as string | null | undefined)).toBe(expected);
  });
});

describe("normalizeArticleStatus", () => {
  it("herkent actief (default)", () => {
    expect(normalizeArticleStatus("ACTIEF")).toBe("ACTIVE");
    expect(normalizeArticleStatus(null)).toBe("ACTIVE");
    expect(normalizeArticleStatus("")).toBe("ACTIVE");
  });

  it("herkent geblokkeerd/inactief", () => {
    expect(normalizeArticleStatus("GEBLOKKEERD")).toBe("INACTIVE");
    expect(normalizeArticleStatus("Inactief")).toBe("INACTIVE");
    expect(normalizeArticleStatus("uitgefaseerd")).toBe("INACTIVE");
  });
});

describe("computeFrequencyBreakdown", () => {
  it("telt elke categorie en som klopt met totaal", () => {
    const articles = [
      makeArticle({ id: "1", countPeriod: "MONTHLY" }),
      makeArticle({ id: "2", countPeriod: "MONTHLY" }),
      makeArticle({ id: "3", countPeriod: "QUARTERLY" }),
      makeArticle({ id: "4", countPeriod: "YEARLY" }),
      makeArticle({ id: "5", countPeriod: "NOT_APPLICABLE" }),
      makeArticle({ id: "6", countPeriod: "TO_BE_DETERMINED" }),
    ];
    const breakdown = computeFrequencyBreakdown(articles);
    expect(breakdown).toEqual({
      monthly: 2,
      quarterly: 1,
      yearly: 1,
      notApplicable: 1,
      toBeDetermined: 1,
      total: 6,
    });
  });
});

describe("selectArticlesForSessionType", () => {
  const monthly = makeArticle({ id: "m", countPeriod: "MONTHLY" });
  const quarterly = makeArticle({ id: "q", countPeriod: "QUARTERLY" });
  const yearly = makeArticle({ id: "y", countPeriod: "YEARLY" });
  const nvt = makeArticle({ id: "n", countPeriod: "NOT_APPLICABLE" });
  const tbd = makeArticle({ id: "t", countPeriod: "TO_BE_DETERMINED" });
  const inactive = makeArticle({ id: "i", countPeriod: "MONTHLY", status: "INACTIVE" });
  const all = [monthly, quarterly, yearly, nvt, tbd, inactive];

  it("MONTHLY neemt enkel MAAND mee", () => {
    const result = selectArticlesForSessionType(all, "MONTHLY");
    expect(result.map((a) => a.id)).toEqual(["m"]);
  });

  it("QUARTERLY neemt MAAND + KWARTAAL mee", () => {
    const result = selectArticlesForSessionType(all, "QUARTERLY");
    expect(result.map((a) => a.id).sort()).toEqual(["m", "q"]);
  });

  it("YEARLY neemt MAAND + KWARTAAL + JAAR mee", () => {
    const result = selectArticlesForSessionType(all, "YEARLY");
    expect(result.map((a) => a.id).sort()).toEqual(["m", "q", "y"]);
  });

  it("FULL neemt alle actieve artikelen mee, ongeacht frequentie (incl. NVT en NOG_TE_BEPALEN)", () => {
    const result = selectArticlesForSessionType(all, "FULL");
    expect(result.map((a) => a.id).sort()).toEqual(["m", "n", "q", "t", "y"]);
  });

  it("sluit geblokkeerde/inactieve artikelen standaard uit, ook bij FULL", () => {
    const result = selectArticlesForSessionType(all, "FULL");
    expect(result.some((a) => a.id === "i")).toBe(false);
  });

  it("kan inactieve artikelen toch meenemen als expliciet gevraagd", () => {
    const result = selectArticlesForSessionType(all, "FULL", { includeInactive: true });
    expect(result.some((a) => a.id === "i")).toBe(true);
  });
});

describe("articlesNeedingReview", () => {
  it("geeft enkel NOG_TE_BEPALEN artikelen terug", () => {
    const tbd = makeArticle({ id: "t", countPeriod: "TO_BE_DETERMINED" });
    const monthly = makeArticle({ id: "m", countPeriod: "MONTHLY" });
    expect(articlesNeedingReview([tbd, monthly]).map((a) => a.id)).toEqual(["t"]);
  });
});
