import { describe, expect, it } from "vitest";
import {
  buildNextPreviousCounts,
  computeSessionArticleTotals,
  computeSessionReview,
  filterReviewResults,
  isSessionReadyToComplete,
  sortReviewResults,
} from "./review";
import type { Article, CountEntry, CountSession, Location, LocationSessionStatus } from "./types";

const locations: Location[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `office-1:loc-${n}`,
  officeId: "office-1",
  number: n,
  name: `Locatie ${n}`,
  active: true,
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
  locationId: string | null,
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
    resolution: "COUNTED",
    ...overrides,
  };
}

function makeSession(articleIds: string[]): Pick<CountSession, "articleIds"> {
  return { articleIds };
}

function makeLocationStatus(
  locationId: string,
  status: LocationSessionStatus["status"] = "COMPLETED",
): LocationSessionStatus {
  return { id: `session-1:${locationId}`, sessionId: "session-1", locationId, status, completedAt: null };
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
  const allLocationsCompletedStatuses = locations.map((l) => makeLocationStatus(l.id));

  it("false wanneer er nog niet-getelde artikelen zijn (ook al zijn alle locaties afgerond)", () => {
    const article = makeArticle("A1");
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      locations,
      [],
      allLocationsCompletedStatuses,
    );
    expect(isSessionReadyToComplete(review)).toBe(false);
  });

  it("true wanneer alle scope-artikelen volledig geteld zijn EN alle actieve locaties afgerond zijn", () => {
    const article = makeArticle("A1");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      locations,
      entries,
      allLocationsCompletedStatuses,
    );
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
      allLocationsCompletedStatuses,
    );
    expect(isSessionReadyToComplete(review)).toBe(true);
  });

  it("alle artikelen opgelost maar 1 locatie nog open -> niet afrondbaar (spec v0.2.1 §6)", () => {
    const article = makeArticle("A1");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    // Locatie 5 blijft OPEN — alle andere locaties zijn afgerond.
    const statuses = locations.filter((l) => l.id !== "office-1:loc-5").map((l) => makeLocationStatus(l.id));
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries, statuses);
    expect(review.allLocationsCompleted).toBe(false);
    expect(review.incompleteActiveLocations.map((l) => l.id)).toEqual(["office-1:loc-5"]);
    expect(isSessionReadyToComplete(review)).toBe(false);
  });

  it("alle locaties afgerond maar 1 artikel onopgelost -> niet afrondbaar", () => {
    const counted = makeArticle("A1");
    const notCounted = makeArticle("A2");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    const review = computeSessionReview(
      makeSession(["office-1:A1", "office-1:A2"]),
      [counted, notCounted],
      locations,
      entries,
      allLocationsCompletedStatuses,
    );
    expect(review.allLocationsCompleted).toBe(true);
    expect(review.notCountedArticles).toBe(1);
    expect(isSessionReadyToComplete(review)).toBe(false);
  });

  it("alles afgerond en opgelost -> wel afrondbaar", () => {
    const article = makeArticle("A1");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      locations,
      entries,
      allLocationsCompletedStatuses,
    );
    expect(isSessionReadyToComplete(review)).toBe(true);
  });

  it("een inactieve locatie blokkeert afronden niet, ook al is ze nooit afgerond", () => {
    const inactiveLocations = locations.map((l, i) => (i === 0 ? { ...l, active: false } : l));
    const article = makeArticle("A1");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    // Enkel de actieve locaties (index 1-4) worden afgerond; de inactieve (index 0) blijft OPEN.
    const statuses = inactiveLocations.filter((l) => l.active).map((l) => makeLocationStatus(l.id));
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      inactiveLocations,
      entries,
      statuses,
    );
    expect(review.allLocationsCompleted).toBe(true);
    expect(isSessionReadyToComplete(review)).toBe(true);
  });

  it("'Zonder locatie' (een expliciete voorraad-0-bevestiging zonder fysieke locatie) blokkeert locatie-afronding niet", () => {
    const article = makeArticle("A1");
    // CONFIRMED_ABSENT heeft bewust locationId=null — er is geen fysieke
    // Location om af te ronden, en dat mag de sessie dus nooit blokkeren
    // zolang de échte locaties zelf allemaal afgerond zijn.
    const entries = [makeEntry("office-1:A1", null, { quantity: 0, counted: true, resolution: "CONFIRMED_ABSENT" })];
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      locations,
      entries,
      allLocationsCompletedStatuses,
    );
    expect(isSessionReadyToComplete(review)).toBe(true);
  });

  it("een afgeronde locatie die opnieuw geopend wordt, maakt de sessie opnieuw niet afrondbaar", () => {
    const article = makeArticle("A1");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 0, counted: true })];
    const readyReview = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      locations,
      entries,
      allLocationsCompletedStatuses,
    );
    expect(isSessionReadyToComplete(readyReview)).toBe(true);

    // Locatie 1 wordt heropend: haar status wordt weer OPEN (bv. via
    // CountingService.reopenLocation) — computeSessionReview wordt altijd
    // vers herberekend uit de actuele statussen, nooit gecached.
    const statusesAfterReopen = [
      makeLocationStatus("office-1:loc-1", "OPEN"),
      ...allLocationsCompletedStatuses.slice(1),
    ];
    const reopenedReview = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      locations,
      entries,
      statusesAfterReopen,
    );
    expect(reopenedReview.allLocationsCompleted).toBe(false);
    expect(isSessionReadyToComplete(reopenedReview)).toBe(false);
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

describe("nergens aangetroffen (v0.2.1 §5)", () => {
  it("allLocationsCompleted is false zolang niet elke actieve locatie COMPLETED is", () => {
    const article = makeArticle("A1");
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, [], [
      makeLocationStatus("office-1:loc-1"),
    ]);
    expect(review.allLocationsCompleted).toBe(false);
  });

  it("allLocationsCompleted is true zodra alle actieve locaties COMPLETED zijn", () => {
    const article = makeArticle("A1");
    const statuses = locations.map((l) => makeLocationStatus(l.id));
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, [], statuses);
    expect(review.allLocationsCompleted).toBe(true);
  });

  it("totalActiveLocations/completedActiveLocationsCount/incompleteActiveLocations tonen de juiste voortgang (spec v0.2.1 §6-teller)", () => {
    const article = makeArticle("A1");
    const statuses = [locations[0], locations[1], locations[2]].map((l) => makeLocationStatus(l.id));
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, [], statuses);
    expect(review.totalActiveLocations).toBe(5);
    expect(review.completedActiveLocationsCount).toBe(3);
    expect(review.incompleteActiveLocations.map((l) => l.name)).toEqual(["Locatie 4", "Locatie 5"]);
  });

  it("een inactieve locatie telt niet mee voor allLocationsCompleted", () => {
    const inactiveLocations = locations.map((l, i) => (i === 0 ? { ...l, active: false } : l));
    const article = makeArticle("A1");
    const statuses = inactiveLocations.filter((l) => l.active).map((l) => makeLocationStatus(l.id));
    const review = computeSessionReview(
      makeSession(["office-1:A1"]),
      [article],
      inactiveLocations,
      [],
      statuses,
    );
    expect(review.allLocationsCompleted).toBe(true);
  });

  it("een artikel zonder enige entry staat in notFoundAnywhere", () => {
    const found = makeArticle("A1");
    const missing = makeArticle("A2");
    const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 3, counted: true })];
    const review = computeSessionReview(
      makeSession(["office-1:A1", "office-1:A2"]),
      [found, missing],
      locations,
      entries,
    );
    expect(review.notFoundAnywhere.map((r) => r.articleId)).toEqual(["office-1:A2"]);
  });

  it("expliciet afwezig (CONFIRMED_ABSENT) is een geldige telling van 0, geen 'niet geteld'", () => {
    const article = makeArticle("A1", { previousCount: 4 });
    const entries = [
      makeEntry("office-1:A1", null, { quantity: 0, counted: true, resolution: "CONFIRMED_ABSENT" }),
    ];
    const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
    const result = review.results[0];
    expect(result.fullyCounted).toBe(true);
    expect(result.confirmedAbsent).toBe(true);
    expect(result.hasAnyEntry).toBe(true);
    expect(result.newTotalCount).toBe(0);
    expect(result.differenceQuantity).toBe(-4);
    expect(review.notFoundAnywhere).toHaveLength(0);
    expect(review.notCountedArticles).toBe(0);
    // Geen van de vijf fysieke locaties kreeg een entry toegewezen — er is
    // bewust geen fictieve locatie verzonnen voor deze bevestiging.
    expect(result.perLocation.every((loc) => !loc.hasEntry)).toBe(true);
  });

  it("niet-geteld en expliciet-afwezig-0 zijn nooit met elkaar te verwarren", () => {
    const notCounted = makeArticle("A1");
    const confirmedAbsent = makeArticle("A2");
    const entries = [
      makeEntry("office-1:A2", null, { quantity: 0, counted: true, resolution: "CONFIRMED_ABSENT" }),
    ];
    const review = computeSessionReview(
      makeSession(["office-1:A1", "office-1:A2"]),
      [notCounted, confirmedAbsent],
      locations,
      entries,
    );
    const r1 = review.results.find((r) => r.articleId === "office-1:A1")!;
    const r2 = review.results.find((r) => r.articleId === "office-1:A2")!;
    expect(r1.fullyCounted).toBe(false);
    expect(r1.newTotalCount).toBeNull();
    expect(r2.fullyCounted).toBe(true);
    expect(r2.newTotalCount).toBe(0);
  });
});

describe("computeSessionArticleTotals", () => {
  it("somt enkel counted-entries per artikel op", () => {
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 3, counted: true }),
      makeEntry("office-1:A1", "office-1:loc-2", { quantity: 4, counted: true }),
      makeEntry("office-1:A2", "office-1:loc-1", { quantity: 99, counted: false }), // niet geteld -> telt niet mee
    ];
    const totals = computeSessionArticleTotals(entries);
    expect(totals.get("office-1:A1")).toBe(7);
    expect(totals.has("office-1:A2")).toBe(false);
  });

  it("geeft een lege map voor lege entries", () => {
    expect(computeSessionArticleTotals([]).size).toBe(0);
  });
});

describe(
  "computeSessionReview — vergelijken met een willekeurig gekozen telling (aanvulling: \"je moet hier ook " +
    "kunnen kiezen om te vergelijken met een willekeurig gekozen telling\")",
  () => {
    it("gebruikt Article.previousCount zoals voorheen wanneer geen comparisonCounts wordt meegegeven", () => {
      const article = makeArticle("A1", { previousCount: 10, costPrice: 2 });
      const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 7, counted: true })];
      const review = computeSessionReview(makeSession(["office-1:A1"]), [article], locations, entries);
      expect(review.results[0].previousCount).toBe(10);
      expect(review.results[0].differenceQuantity).toBe(-3);
    });

    it("gebruikt de meegegeven comparisonCounts i.p.v. Article.previousCount wanneer die is meegegeven", () => {
      const article = makeArticle("A1", { previousCount: 10, costPrice: 2 });
      const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 7, counted: true })];
      const comparisonCounts = new Map([["office-1:A1", 20]]);
      const review = computeSessionReview(
        makeSession(["office-1:A1"]),
        [article],
        locations,
        entries,
        [],
        comparisonCounts,
      );
      const result = review.results[0];
      expect(result.previousCount).toBe(20); // niet 10 (Article.previousCount)
      expect(result.differenceQuantity).toBe(-13); // 7 - 20
      expect(result.differenceAmount).toBeCloseTo(-26); // -13 * 2
    });

    it("previousCount blijft null wanneer het artikel niet voorkomt in de gekozen vergelijkingssessie (nooit een fictieve 0)", () => {
      const article = makeArticle("A1", { previousCount: 10 });
      const entries = [makeEntry("office-1:A1", "office-1:loc-1", { quantity: 7, counted: true })];
      const comparisonCounts = new Map<string, number>(); // A1 zat niet in die andere sessie
      const review = computeSessionReview(
        makeSession(["office-1:A1"]),
        [article],
        locations,
        entries,
        [],
        comparisonCounts,
      );
      expect(review.results[0].previousCount).toBeNull();
      expect(review.results[0].differenceQuantity).toBeNull(); // nooit "7 - 0"
    });
  },
);

describe("sortReviewResults", () => {
  it("DEFAULT verandert de volgorde niet", () => {
    const a1 = makeArticle("A1", { previousCount: 5, costPrice: 1 });
    const a2 = makeArticle("A2", { previousCount: 5, costPrice: 9 });
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 5, counted: true }),
      makeEntry("office-1:A2", "office-1:loc-1", { quantity: 5, counted: true }),
    ];
    const review = computeSessionReview(makeSession(["office-1:A1", "office-1:A2"]), [a1, a2], locations, entries);
    expect(sortReviewResults(review.results, "DEFAULT").map((r) => r.articleId)).toEqual([
      "office-1:A1",
      "office-1:A2",
    ]);
  });

  it("DIFFERENCE_AMOUNT_DESC sorteert van hoog naar laag verschil-bedrag, met null altijd laatst", () => {
    const a1 = makeArticle("A1", { previousCount: 10, costPrice: 1 }); // -5 verschil-aantal -> -5 €
    const a2 = makeArticle("A2", { previousCount: 0, costPrice: 2 }); // +10 verschil-aantal -> +20 €
    const a3 = makeArticle("A3", { previousCount: 0, costPrice: 1 }); // niet geteld -> null
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 5, counted: true }),
      makeEntry("office-1:A2", "office-1:loc-1", { quantity: 10, counted: true }),
    ];
    const review = computeSessionReview(
      makeSession(["office-1:A1", "office-1:A2", "office-1:A3"]),
      [a1, a2, a3],
      locations,
      entries,
    );
    const sorted = sortReviewResults(review.results, "DIFFERENCE_AMOUNT_DESC");
    expect(sorted.map((r) => r.articleId)).toEqual(["office-1:A2", "office-1:A1", "office-1:A3"]);
  });

  it("COST_PRICE_DESC sorteert van hoge naar lage kostprijs, met null altijd laatst", () => {
    const a1 = makeArticle("A1", { costPrice: 3 });
    const a2 = makeArticle("A2", { costPrice: 9 });
    const a3 = makeArticle("A3", { costPrice: null });
    const review = computeSessionReview(makeSession(["office-1:A1", "office-1:A2", "office-1:A3"]), [a1, a2, a3], locations, []);
    const sorted = sortReviewResults(review.results, "COST_PRICE_DESC");
    expect(sorted.map((r) => r.articleId)).toEqual(["office-1:A2", "office-1:A1", "office-1:A3"]);
  });

  it("DIFFERENCE_QUANTITY_DESC sorteert van hoog naar laag verschil-aantal, met null altijd laatst", () => {
    const a1 = makeArticle("A1", { previousCount: 10 }); // -7
    const a2 = makeArticle("A2", { previousCount: 0 }); // +8
    const a3 = makeArticle("A3", { previousCount: 0 }); // niet geteld -> null
    const entries = [
      makeEntry("office-1:A1", "office-1:loc-1", { quantity: 3, counted: true }),
      makeEntry("office-1:A2", "office-1:loc-1", { quantity: 8, counted: true }),
    ];
    const review = computeSessionReview(
      makeSession(["office-1:A1", "office-1:A2", "office-1:A3"]),
      [a1, a2, a3],
      locations,
      entries,
    );
    const sorted = sortReviewResults(review.results, "DIFFERENCE_QUANTITY_DESC");
    expect(sorted.map((r) => r.articleId)).toEqual(["office-1:A2", "office-1:A1", "office-1:A3"]);
  });
});
