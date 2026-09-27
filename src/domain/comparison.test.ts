import { describe, expect, it } from "vitest";
import {
  CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD,
  buildSessionComparison,
  computeConsecutiveUnchanged,
  filterArticleComparisonRows,
  sortArticleComparisonRows,
  DEFAULT_ARTICLE_COMPARISON_FILTERS,
  type ArticleComparisonRow,
  type ComparisonSnapshotInput,
  type ReliableHistoryEntry,
} from "./comparison";
import { PRODUCT_CATEGORY_FALLBACK, type ArticleCategoryResolution } from "./productCategory";
import { buildLegacyPeriodSnapshot } from "./stockSnapshot";
import type { ArticleSnapshot, ArticleSnapshotStatus, StockHistoryEntry, StockSnapshot } from "./stockSnapshot";
import type { Article } from "./types";

/** Testhelper (Sprint 3.2 §12), zelfde patroon als analysis.test.ts: expliciete `articleId -> categorie`-resolutiemap. */
function resolution(byArticleId: Record<string, string | null>): Map<string, ArticleCategoryResolution> {
  const map = new Map<string, ArticleCategoryResolution>();
  for (const [articleId, categoryName] of Object.entries(byArticleId)) {
    map.set(articleId, {
      categoryId: categoryName ? `cat:${categoryName}` : null,
      categoryName: categoryName ?? PRODUCT_CATEGORY_FALLBACK,
    });
  }
  return map;
}

/**
 * Sprint 3 — Vergelijking tussen stocktellingen. Zelfde fixture-filosofie als
 * `analysis.test.ts`: puur domeinlagen, met handgeschreven maar realistische
 * `StockSnapshot`-fixtures (rechtstreeks als `ArticleSnapshot[]`, exact de
 * vorm die `stockSnapshot.ts#buildSessionSnapshot` ook produceert).
 */

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return Object.freeze({
    id: `office:${articleNumber}`,
    officeId: "office",
    articleNumber,
    officialArticleNumber: articleNumber,
    idType: "OFFICIEEL",
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "STUKS",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
    ...overrides,
  }) as Article;
}

function makeRow(
  art: Article,
  opts: { quantity: number | null; status?: ArticleSnapshotStatus; costPrice?: number | null },
): ArticleSnapshot {
  const costPrice = opts.costPrice === undefined ? art.costPrice : opts.costPrice;
  const quantity = opts.quantity;
  const amount = quantity !== null && costPrice !== null ? quantity * costPrice : null;
  return Object.freeze({
    articleId: art.id,
    article: art,
    status: opts.status ?? (quantity === null ? "OVERGENOMEN" : "GETELD"),
    totalCount: quantity,
    previousCount: quantity,
    differenceQuantity: 0,
    costPrice,
    previousValue: amount,
    amount,
    differenceAmount: 0,
    perLocation: [],
    note: null,
  }) as ArticleSnapshot;
}

function makeSnapshot(sessionId: string, sessionName: string, rows: ArticleSnapshot[]): StockSnapshot {
  return { sessionId, sessionType: "MONTHLY", sessionName, snapshotDate: "2026-09-01", articles: rows };
}

function makeInput(sessionId: string, sessionName: string, snapshot: StockSnapshot): ComparisonSnapshotInput {
  return {
    sessionId,
    sessionName,
    sessionType: "MONTHLY",
    snapshotDate: snapshot.snapshotDate,
    completedAt: `${snapshot.snapshotDate}T12:00:00.000Z`,
    snapshot,
    provenance: "APP_COUNT",
  };
}

/** `historyNewestFirstFromB` met enkel B zelf — voor tests die de opeenvolgende-tellingen-berekening niet nodig hebben. */
function historyWithOnlyB(inputB: ComparisonSnapshotInput): ReliableHistoryEntry[] {
  return [
    {
      sessionId: inputB.sessionId,
      sessionName: inputB.sessionName,
      articlesById: new Map(inputB.snapshot.articles.map((a) => [a.articleId, { totalCount: a.totalCount, status: a.status }])),
    },
  ];
}

describe("Waarde (spec §16 'Waarde')", () => {
  it("berekent totale stockwaarde A/B, delta €, delta % en productgammatotalen correct (Sprint 3.2 §12: canoniek/retroactief)", () => {
    const a1 = makeArticle("A1", { costPrice: 2 });
    const a2 = makeArticle("A2", { costPrice: 10, stockClassification: "OBSOLETE" });

    const snapA = makeSnapshot("s-a", "2026-08 Maand", [
      makeRow(a1, { quantity: 10 }), // 20
      makeRow(a2, { quantity: 5 }), // 50
    ]);
    const snapB = makeSnapshot("s-b", "2026-09 Maand", [
      makeRow(a1, { quantity: 15 }), // 30
      makeRow(a2, { quantity: 5 }), // 50
    ]);
    const inputA = makeInput("s-a", "2026-08 Maand", snapA);
    const inputB = makeInput("s-b", "2026-09 Maand", snapB);
    const categoryResolution = resolution({ "office:A1": "G1", "office:A2": "G2" });

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), categoryResolution);

    expect(comparison.kpis.stockValue.valueA).toBe(70);
    expect(comparison.kpis.stockValue.valueB).toBe(80);
    expect(comparison.kpis.stockValue.differenceAmount).toBe(10);
    expect(comparison.kpis.stockValue.differencePercent).toBeCloseTo((10 / 70) * 100, 5);

    expect(comparison.kpis.obsolete.valueA).toBe(50);
    expect(comparison.kpis.obsolete.valueB).toBe(50);
    expect(comparison.kpis.obsolete.differenceAmount).toBe(0);

    const g1 = comparison.productCategories.find((g) => g.productCategory === "G1");
    const g2 = comparison.productCategories.find((g) => g.productCategory === "G2");
    expect(g1?.valueA).toBe(20);
    expect(g1?.valueB).toBe(30);
    expect(g1?.valueDifference).toBe(10);
    expect(g2?.valueDifference).toBe(0);
    // Default sortering: grootste absolute verandering eerst.
    expect(comparison.productCategories[0].productCategory).toBe("G1");
  });

  it("differencePercent is null wanneer de basiswaarde (A) 0 is — nooit fictief 0% of Infinity", () => {
    const a1 = makeArticle("A1", { costPrice: 5 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 0 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 3 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map());
    expect(comparison.kpis.stockValue.valueA).toBe(0);
    expect(comparison.kpis.stockValue.differencePercent).toBeNull();
  });
});

describe("Artikelmatching (spec §16 'Artikelmatching')", () => {
  const shared = makeArticle("SHARED", { costPrice: 3 });
  const onlyInA = makeArticle("ONLY_A", { costPrice: 3 });
  const onlyInB = makeArticle("ONLY_B", { costPrice: 3 });

  const snapA = makeSnapshot("s-a", "A", [
    makeRow(shared, { quantity: 4 }),
    makeRow(onlyInA, { quantity: 7 }),
  ]);
  const snapB = makeSnapshot("s-b", "B", [
    makeRow(shared, { quantity: 4 }),
    makeRow(onlyInB, { quantity: 2 }),
  ]);
  const inputA = makeInput("s-a", "A", snapA);
  const inputB = makeInput("s-b", "B", snapB);
  const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map());
  const byNumber = new Map(comparison.articles.map((r) => [r.articleNumber, r]));

  it("artikel aanwezig in beide snapshots wordt correct als 'beide gekend' herkend", () => {
    const row = byNumber.get("SHARED")!;
    expect(row.presentInA).toBe(true);
    expect(row.presentInB).toBe(true);
    expect(row.isNewArticle).toBe(false);
    expect(row.isDisappeared).toBe(false);
  });

  it("artikel enkel in A (ontbreekt in B) wordt herkend als 'niet meer aanwezig in B', nooit als voorraad 0", () => {
    const row = byNumber.get("ONLY_A")!;
    expect(row.presentInA).toBe(true);
    expect(row.presentInB).toBe(false);
    expect(row.isDisappeared).toBe(true);
    expect(row.isToZero).toBe(false); // ontbreken ≠ naar 0
    expect(row.quantityB).toBeNull();
  });

  it("artikel enkel in B (ontbreekt in A) wordt herkend als 'nieuw artikel'", () => {
    const row = byNumber.get("ONLY_B")!;
    expect(row.presentInA).toBe(false);
    expect(row.presentInB).toBe(true);
    expect(row.isNewArticle).toBe(true);
  });

  it("quantity 0 (gekend) en ontbrekend artikel worden correct onderscheiden — nooit door elkaar gehaald", () => {
    const zero = makeArticle("ZERO", { costPrice: 1 });
    const snapA2 = makeSnapshot("s-a2", "A2", [makeRow(zero, { quantity: 0, status: "0 BEVESTIGD" })]);
    const snapB2 = makeSnapshot("s-b2", "B2", [makeRow(zero, { quantity: 5 })]);
    const inputA2 = makeInput("s-a2", "A2", snapA2);
    const inputB2 = makeInput("s-b2", "B2", snapB2);
    const cmp = buildSessionComparison(inputA2, inputB2, historyWithOnlyB(inputB2), new Map());
    const row = cmp.articles.find((r) => r.articleNumber === "ZERO")!;
    expect(row.quantityA).toBe(0); // gekende 0, geen `null`
    expect(row.isFromZero).toBe(true);
    expect(row.presentInA).toBe(true);
  });
});

describe("Ongewijzigd (spec §16 'Ongewijzigd' / spec §7)", () => {
  it("gelijke quantity → unchanged", () => {
    const a1 = makeArticle("A1", { costPrice: 4 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 6 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 6 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);
    const cmp = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map());
    const row = cmp.articles[0];
    expect(row.quantityUnchanged).toBe(true);
    expect(row.quantityChanged).toBe(false);
    expect(row.valueDifference).toBe(0);
  });

  it("gelijke quantity + andere kostprijs → quantity unchanged, waarde changed (moet zichtbaar blijven)", () => {
    const a1 = makeArticle("A1");
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 6, costPrice: 4 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 6, costPrice: 9 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);
    const cmp = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map());
    const row = cmp.articles[0];
    expect(row.quantityUnchanged).toBe(true);
    expect(row.valueDifference).toBe(6 * 9 - 6 * 4); // 30 — waardewijziging blijft zichtbaar
    expect(row.valueDifference).not.toBe(0);
  });

  it("andere quantity → changed", () => {
    const a1 = makeArticle("A1", { costPrice: 4 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 6 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 9 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);
    const cmp = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map());
    const row = cmp.articles[0];
    expect(row.quantityChanged).toBe(true);
    expect(row.quantityUnchanged).toBe(false);
    expect(cmp.unchanged.articleCount).toBe(0);
  });
});

describe("Consecutive unchanged (spec §16 'Consecutive unchanged' / spec §8)", () => {
  const art = makeArticle("A1");

  function entry(sessionName: string, quantity: number | null, reliable = true): ReliableHistoryEntry {
    return reliable
      ? { sessionId: sessionName, sessionName, articlesById: new Map([[art.id, { totalCount: quantity, status: "GETELD" as ArticleSnapshotStatus }]]) }
      : { sessionId: sessionName, sessionName };
  }

  it("1 telling: enkel B gekend → count 1", () => {
    const result = computeConsecutiveUnchanged(art.id, [entry("B", 5)]);
    expect(result.count).toBe(1);
    expect(result.sinceSessionName).toBe("B");
    expect(result.reachedStartOfHistory).toBe(true);
  });

  it("2 tellingen ongewijzigd → count 2", () => {
    const result = computeConsecutiveUnchanged(art.id, [entry("B", 5), entry("A", 5)]);
    expect(result.count).toBe(2);
    expect(result.sinceSessionName).toBe("A");
  });

  it("3+ tellingen ongewijzigd → count blijft correct oplopen, stopt bij het eerste verschil", () => {
    const result = computeConsecutiveUnchanged(art.id, [
      entry("D", 5),
      entry("C", 5),
      entry("B", 5),
      entry("A", 3), // verschil hier — de reeks stopt
    ]);
    expect(result.count).toBe(3);
    expect(result.sinceSessionName).toBe("B");
    expect(result.lastQuantityChangeSessionName).toBe("A");
    expect(result.reachedStartOfHistory).toBe(false);
  });

  it("ontbrekende snapshot (artikel bestond nog niet) stopt de keten, telt niet als 0", () => {
    const withoutArticle: ReliableHistoryEntry = { sessionId: "OLD", sessionName: "OLD", articlesById: new Map() };
    const result = computeConsecutiveUnchanged(art.id, [entry("B", 5), entry("A", 5), withoutArticle]);
    expect(result.count).toBe(2);
    expect(result.lastQuantityChangeSessionName).toBeNull(); // geen verschil gezien, gewoon onbekend
    expect(result.reachedStartOfHistory).toBe(false);
  });

  it("legacy/onbetrouwbare sessie stopt de keten hard — mag niet stilzwijgend meetellen", () => {
    const result = computeConsecutiveUnchanged(art.id, [entry("B", 5), entry("A", 5), entry("LEGACY", 5, false)]);
    expect(result.count).toBe(2); // niet 3, ondanks dat de hoeveelheid daar toevallig ook 5 zou kunnen zijn
    expect(result.reachedStartOfHistory).toBe(false);
  });
});

describe("Kandidaten voor obsolete-review (spec §16 'Obsolete kandidaten' / spec §9)", () => {
  function buildComparisonWithHistory(classification: "ACTIVE" | "OBSOLETE", quantityB: number, historyLength: number) {
    const art = makeArticle("CAND", { stockClassification: classification, costPrice: 5 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(art, { quantity: quantityB })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(art, { quantity: quantityB })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);
    const history: ReliableHistoryEntry[] = Array.from({ length: historyLength }, (_, i) => ({
      sessionId: `h${i}`,
      sessionName: `h${i}`,
      articlesById: new Map([[art.id, { totalCount: quantityB, status: "GETELD" as ArticleSnapshotStatus }]]),
    }));
    return buildSessionComparison(inputA, inputB, history, new Map());
  }

  it("ACTIVE + quantity > 0 + ≥3 opeenvolgende ongewijzigde tellingen → kandidaat", () => {
    const cmp = buildComparisonWithHistory("ACTIVE", 4, 3);
    const row = cmp.articles[0];
    expect(row.consecutiveUnchangedCount).toBe(3);
    expect(row.isObsoleteCandidate).toBe(true);
    expect(cmp.obsoleteCandidates).toHaveLength(1);
  });

  it("OBSOLETE classificatie → nooit kandidaat, ondanks lange ongewijzigde reeks", () => {
    const cmp = buildComparisonWithHistory("OBSOLETE", 4, 5);
    expect(cmp.articles[0].isObsoleteCandidate).toBe(false);
    expect(cmp.obsoleteCandidates).toHaveLength(0);
  });

  it("quantity 0 → nooit kandidaat", () => {
    const cmp = buildComparisonWithHistory("ACTIVE", 0, 5);
    expect(cmp.articles[0].isObsoleteCandidate).toBe(false);
  });

  it("minder dan de drempel opeenvolgende tellingen → geen kandidaat", () => {
    const cmp = buildComparisonWithHistory("ACTIVE", 4, CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD - 1);
    expect(cmp.articles[0].isObsoleteCandidate).toBe(false);
  });

  it("de vergelijking muteert nooit het meegegeven Article-object (strikt read-only)", () => {
    // De fixtures hierboven bevriezen `article` al met Object.freeze — een
    // poging tot mutatie door de vergelijkingslogica zou hier een
    // TypeError gooien (strict mode); het enkel foutloos doorlopen van deze
    // hele testsuite bewijst dus al de read-only-garantie. Extra expliciete
        // check: het object blijft `toEqual` zichzelf na de aanroep.
    const art = makeArticle("IMMUTABLE", { stockClassification: "ACTIVE", costPrice: 5 });
    const before = { ...art };
    const snapA = makeSnapshot("s-a", "A", [makeRow(art, { quantity: 4 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(art, { quantity: 4 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);
    buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map());
    expect(art).toEqual(before);
  });
});

describe("Classificatie-overgangen (spec §16 'Classificatie' / spec §10)", () => {
  function buildTransition(classA: "ACTIVE" | "OBSOLETE", classB: "ACTIVE" | "OBSOLETE") {
    const artA = makeArticle("T1", { stockClassification: classA });
    const artB = makeArticle("T1", { stockClassification: classB });
    const snapA = makeSnapshot("s-a", "A", [makeRow(artA, { quantity: 3 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(artB, { quantity: 3 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);
    return buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), new Map()).articles[0];
  }

  it("ACTIVE → OBSOLETE: nieuw obsolete", () => {
    const row = buildTransition("ACTIVE", "OBSOLETE");
    expect(row.isNewObsolete).toBe(true);
    expect(row.isStayedObsolete).toBe(false);
    expect(row.isReactivated).toBe(false);
  });

  it("OBSOLETE → OBSOLETE: obsolete gebleven", () => {
    const row = buildTransition("OBSOLETE", "OBSOLETE");
    expect(row.isStayedObsolete).toBe(true);
    expect(row.isNewObsolete).toBe(false);
  });

  it("OBSOLETE → ACTIVE: opnieuw actief", () => {
    const row = buildTransition("OBSOLETE", "ACTIVE");
    expect(row.isReactivated).toBe(true);
    expect(row.isStayedObsolete).toBe(false);
  });
});

describe("Kostprijsevolutie — prijsverschil en hoeveelheids-/prijseffect-ontbinding (Sprint 3.1 §1-2)", () => {
  it("alleen quantity verandert: prijsverschil 0, hoeveelheidseffect = volledige waardeverandering, prijseffect 0", () => {
    const a1 = makeArticle("A1", { costPrice: 10 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 4, costPrice: 10 })]); // 40
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 7, costPrice: 10 })]); // 70
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.priceDifferencePerUnit).toBe(0);
    expect(row.pricePercentChange).toBe(0);
    expect(row.quantityEffect).toBe(30); // (7-4)*10
    expect(row.priceEffect).toBe(0);
    expect(row.valueDifference).toBe(30);
  });

  it("alleen kostprijs verandert: hoeveelheidseffect 0, prijseffect = volledige waardeverandering", () => {
    const a1 = makeArticle("A1");
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 5, costPrice: 10 })]); // 50
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 5, costPrice: 12 })]); // 60
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.priceDifferencePerUnit).toBe(2);
    expect(row.pricePercentChange).toBeCloseTo(20, 5);
    expect(row.quantityEffect).toBe(0); // (5-5)*10
    expect(row.priceEffect).toBe(10); // 5*(12-10)
    expect(row.valueDifference).toBe(10);
  });

  it("beide veranderen: hoeveelheidseffect + prijseffect telt exact op tot de totale waardeverandering (spec-voorbeeld)", () => {
    // Exact het voorbeeld uit de opdracht: A 10×€100=€1.000, B 12×€110=€1.320.
    const a1 = makeArticle("A1");
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 10, costPrice: 100 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 12, costPrice: 110 })]);
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.quantityEffect).toBe(200); // (12-10)*100
    expect(row.priceEffect).toBe(120); // 12*(110-100)
    expect(row.valueDifference).toBe(320); // 1320 - 1000
    expect((row.quantityEffect as number) + (row.priceEffect as number)).toBe(row.valueDifference);
  });

  it("prijs daalt: prijsverschil en prijseffect zijn negatief, en het artikel verschijnt bij 'Grootste prijsdalingen'", () => {
    const a1 = makeArticle("A1");
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 10, costPrice: 20 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 10, costPrice: 15 })]);
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.priceDifferencePerUnit).toBe(-5);
    expect(row.priceEffect).toBe(-50);
    expect(cmp.priceMovers.biggestDecreases).toHaveLength(1);
    expect(cmp.priceMovers.biggestDecreases[0].articleId).toBe(row.articleId);
    expect(cmp.priceMovers.biggestIncreases).toHaveLength(0);
  });

  it("quantity blijft gelijk (en kostprijs ook): hoeveelheidseffect en prijseffect zijn beide 0, geen fictieve waarde", () => {
    const a1 = makeArticle("A1", { costPrice: 8 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 6, costPrice: 8 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 6, costPrice: 8 })]);
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.quantityEffect).toBe(0);
    expect(row.priceEffect).toBe(0);
    expect(row.valueDifference).toBe(0);
  });

  it("kostprijs ontbreekt in A of B: hoeveelheidseffect/prijseffect/prijsverschil zijn null, NOOIT 0 (spec §2/§7)", () => {
    const a1 = makeArticle("A1");
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 5, costPrice: null })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 8, costPrice: 12 })]);
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.costPriceA).toBeNull();
    expect(row.priceDifferencePerUnit).toBeNull();
    expect(row.pricePercentChange).toBeNull();
    expect(row.quantityEffect).toBeNull();
    expect(row.priceEffect).toBeNull();
    // Dit artikel mag nooit in de prijsstijgingen/-dalingen verschijnen — er is geen betrouwbaar prijsverschil.
    expect(cmp.priceMovers.biggestIncreases.find((r) => r.articleId === row.articleId)).toBeUndefined();
    expect(cmp.priceMovers.biggestDecreases.find((r) => r.articleId === row.articleId)).toBeUndefined();
  });
});

describe("Kostprijs 0 als basiswaarde (v0.6.1 review-punt 1) — percentage nooit Infinity/NaN", () => {
  it("costPriceA = 0: pricePercentChange is null (niet-berekenbaar), nooit Infinity of NaN, prijsverschil in € blijft wel gekend", () => {
    const a1 = makeArticle("A1");
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 5, costPrice: 0 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 5, costPrice: 8 })]);
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    const row = cmp.articles[0];
    expect(row.costPriceA).toBe(0);
    expect(row.priceDifferencePerUnit).toBe(8); // € blijft berekenbaar (8 - 0)
    expect(row.pricePercentChange).toBeNull(); // percentage t.o.v. 0 is niet zinvol — nooit Infinity/NaN
    expect(Number.isFinite(row.pricePercentChange as number)).toBe(false); // null is per definitie niet "finite" — geen Infinity/NaN-lek
    expect(row.priceEffect).toBe(40); // 5 * (8 - 0), quantity ongewijzigd dus quantityEffect blijft 0
    expect(row.quantityEffect).toBe(0);

    // Ook in de "Grootste prijswijzigingen"-sectie geen Infinity/NaN — enkel een gekend €-effect, percentage blijft null.
    const mover = cmp.priceMovers.biggestIncreases.find((r) => r.articleId === row.articleId);
    expect(mover?.pricePercentChange).toBeNull();
    expect(mover?.priceEffect).toBe(40);
  });
});

describe("Grootste prijsstijgingen/dalingen (Sprint 3.1 §6) — sorteert op financieel effect, niet op ruwe €/eenheid-verschil", () => {
  it("een kleine prijswijziging op veel stuks weegt zwaarder dan een grote wijziging op één stuk", () => {
    // Spec-voorbeeld: €1 op 1.000 stuks (€1.000 effect) > €10 op 1 stuk (€10 effect).
    const bulk = makeArticle("BULK", { costPrice: 5 });
    const single = makeArticle("SINGLE", { costPrice: 5 });
    const snapA = makeSnapshot("s-a", "A", [
      makeRow(bulk, { quantity: 1000, costPrice: 5 }),
      makeRow(single, { quantity: 1, costPrice: 5 }),
    ]);
    const snapB = makeSnapshot("s-b", "B", [
      makeRow(bulk, { quantity: 1000, costPrice: 6 }), // +€1/eenheid, 1000 stuks -> €1.000 effect
      makeRow(single, { quantity: 1, costPrice: 15 }), // +€10/eenheid, 1 stuk -> €10 effect
    ]);
    const cmp = buildSessionComparison(makeInput("s-a", "A", snapA), makeInput("s-b", "B", snapB), historyWithOnlyB(makeInput("s-b", "B", snapB)), new Map());
    expect(cmp.priceMovers.biggestIncreases.map((r) => r.articleId)).toEqual([bulk.id, single.id]);
    expect(cmp.priceMovers.biggestIncreases[0].priceEffect).toBe(1000);
    expect(cmp.priceMovers.biggestIncreases[1].priceEffect).toBe(10);
  });
});

describe("Filters/sortering van de volledige detailtabel (spec §12)", () => {
  const rows: ArticleComparisonRow[] = [
    {
      articleId: "1",
      articleNumber: "N1",
      description: "Beta artikel",
      productGroup: "G1",
      productCategoryId: "cat:G1",
      productCategory: "G1",
      unit: "stuk",
      presentInA: true,
      presentInB: true,
      classificationA: "ACTIVE",
      classificationB: "ACTIVE",
      quantityA: 5,
      quantityB: 5,
      quantityDifference: 0,
      costPriceA: 2,
      costPriceB: 2,
      stockValueA: 10,
      stockValueB: 10,
      valueDifference: 0,
      priceDifferencePerUnit: 0,
      pricePercentChange: 0,
      quantityEffect: 0,
      priceEffect: 0,
      quantityUnchanged: true,
      quantityChanged: false,
      isNewArticle: false,
      isDisappeared: false,
      isFromZero: false,
      isToZero: false,
      isNewObsolete: false,
      isStayedObsolete: false,
      isReactivated: false,
      consecutiveUnchangedCount: 1,
      consecutiveUnchangedSinceSessionName: "B",
      consecutiveUnchangedPhysicallyCountedCount: 1,
      lastQuantityChangeSessionName: null,
      isObsoleteCandidate: false,
    },
    {
      articleId: "2",
      articleNumber: "N2",
      description: "Alfa artikel",
      productGroup: "G2",
      productCategoryId: "cat:G2",
      productCategory: "G2",
      unit: "stuk",
      presentInA: true,
      presentInB: true,
      classificationA: "ACTIVE",
      classificationB: "ACTIVE",
      quantityA: 5,
      quantityB: 8,
      quantityDifference: 3,
      costPriceA: 2,
      costPriceB: 2,
      stockValueA: 10,
      stockValueB: 16,
      valueDifference: 6,
      priceDifferencePerUnit: 0,
      pricePercentChange: 0,
      quantityEffect: 6,
      priceEffect: 0,
      quantityUnchanged: false,
      quantityChanged: true,
      isNewArticle: false,
      isDisappeared: false,
      isFromZero: false,
      isToZero: false,
      isNewObsolete: false,
      isStayedObsolete: false,
      isReactivated: false,
      consecutiveUnchangedCount: 0,
      consecutiveUnchangedSinceSessionName: null,
      consecutiveUnchangedPhysicallyCountedCount: 0,
      lastQuantityChangeSessionName: "B",
      isObsoleteCandidate: false,
    },
  ];

  it("filtert op 'gewijzigd'/'ongewijzigd'", () => {
    expect(filterArticleComparisonRows(rows, { ...DEFAULT_ARTICLE_COMPARISON_FILTERS, state: "CHANGED" })).toHaveLength(1);
    expect(filterArticleComparisonRows(rows, { ...DEFAULT_ARTICLE_COMPARISON_FILTERS, state: "UNCHANGED" })[0].articleNumber).toBe("N1");
  });

  it("filtert op productgamma en zoekterm", () => {
    expect(
      filterArticleComparisonRows(rows, { ...DEFAULT_ARTICLE_COMPARISON_FILTERS, productCategory: "G2" }),
    ).toHaveLength(1);
    expect(filterArticleComparisonRows(rows, { ...DEFAULT_ARTICLE_COMPARISON_FILTERS, search: "beta" })).toHaveLength(1);
  });

  it("sorteert op grootste waardeverschil en op omschrijving", () => {
    const byValue = sortArticleComparisonRows(rows, "VALUE_DIFF_DESC");
    expect(byValue[0].articleNumber).toBe("N2");
    const byDescription = sortArticleComparisonRows(rows, "DESCRIPTION");
    expect(byDescription[0].articleNumber).toBe("N2"); // "Alfa" < "Beta"
  });
});

// ---------------------------------------------------------------------------
// Sprint 3.3 §1 — legacy snapshots bruikbaar in Analyse/Vergelijken, ZONDER
// legacy periodes als fake CountSessions te modelleren. `buildLegacyPeriodSnapshot`
// (stockSnapshot.ts) synthetiseert een `StockSnapshot`-vormig object uit
// reeds geïmporteerde `StockHistoryEntry`-rijen; vanaf dat punt is een legacy
// periode voor `buildSessionComparison` gewoon een `ComparisonSnapshotInput`
// zoals elke andere — vandaar dat deze tests rechtstreeks tegen
// `buildSessionComparison` draaien, exact zoals de rest van dit bestand.
// ---------------------------------------------------------------------------

function makeLegacyHistoryEntry(
  periodLabel: string,
  isoDate: string,
  articleId: string,
  articleNumber: string,
  overrides: Partial<StockHistoryEntry> = {},
): StockHistoryEntry {
  return {
    countDate: isoDate,
    sessionType: "FULL",
    sessionName: `LEGACY ${periodLabel}`,
    articleId,
    articleNumber,
    description: `Legacy ${articleNumber}`,
    totalCount: 10,
    previousCount: null,
    differenceQuantity: null,
    costPrice: 5,
    differenceAmount: null,
    status: "LEGACY",
    locationNames: [],
    source: "LEGACY_IMPORT",
    sourceProductGroup: "OUDE BRON GROEP",
    ...overrides,
  };
}

function makeLegacyInput(
  periodLabel: string,
  isoDate: string,
  entries: StockHistoryEntry[],
  articlesById: ReadonlyMap<string, Article>,
): ComparisonSnapshotInput {
  const sessionId = `legacy:${isoDate}`;
  const snapshot = buildLegacyPeriodSnapshot(sessionId, periodLabel, isoDate, entries, articlesById);
  return {
    sessionId,
    sessionName: snapshot.sessionName,
    sessionType: "FULL",
    snapshotDate: isoDate,
    completedAt: isoDate,
    snapshot,
    provenance: "LEGACY_IMPORT",
  };
}

describe("Sprint 3.3 §1 — legacy snapshots in Analyse/Vergelijken (zonder fake CountSessions)", () => {
  it("test 1: LEGACY A -> APP B vergelijking werkt, A duidelijk gelabeld met provenance LEGACY_IMPORT", () => {
    const article = makeArticle("A1", { costPrice: 2 }); // huidige levende kostprijs — mag nooit de legacy-kant beïnvloeden
    const articlesById = new Map([[article.id, article]]);
    const inputA = makeLegacyInput(
      "30/06/2026",
      "2026-06-30",
      [makeLegacyHistoryEntry("30/06/2026", "2026-06-30", article.id, "A1", { totalCount: 10, costPrice: 7 })],
      articlesById,
    );
    const snapB = makeSnapshot("s-b", "2026-09 Maand", [makeRow(article, { quantity: 15 })]);
    const inputB = makeInput("s-b", "2026-09 Maand", snapB);
    const categoryResolution = resolution({ [article.id]: "G1" });

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), categoryResolution);

    expect(comparison.headerA.provenance).toBe("LEGACY_IMPORT");
    expect(comparison.headerB.provenance).toBe("APP_COUNT");
    const row = comparison.articles.find((r) => r.articleId === article.id)!;
    expect(row.quantityA).toBe(10);
    expect(row.quantityB).toBe(15);
    expect(row.costPriceA).toBe(7);
  });

  it("test 2: LEGACY A -> LEGACY B vergelijking werkt, zonder enige echte sessie aan beide kanten", () => {
    const article = makeArticle("A1", { costPrice: 2 });
    const articlesById = new Map([[article.id, article]]);
    const inputA = makeLegacyInput(
      "31/03/2026",
      "2026-03-31",
      [makeLegacyHistoryEntry("31/03/2026", "2026-03-31", article.id, "A1", { totalCount: 8, costPrice: 6 })],
      articlesById,
    );
    const inputB = makeLegacyInput(
      "30/06/2026",
      "2026-06-30",
      [makeLegacyHistoryEntry("30/06/2026", "2026-06-30", article.id, "A1", { totalCount: 10, costPrice: 7 })],
      articlesById,
    );
    const history: ReliableHistoryEntry[] = [
      {
        sessionId: inputB.sessionId,
        sessionName: inputB.sessionName,
        articlesById: new Map(inputB.snapshot.articles.map((a) => [a.articleId, { totalCount: a.totalCount, status: a.status }])),
      },
      {
        sessionId: inputA.sessionId,
        sessionName: inputA.sessionName,
        articlesById: new Map(inputA.snapshot.articles.map((a) => [a.articleId, { totalCount: a.totalCount, status: a.status }])),
      },
    ];
    const categoryResolution = resolution({ [article.id]: "G1" });

    const comparison = buildSessionComparison(inputA, inputB, history, categoryResolution);

    expect(comparison.headerA.provenance).toBe("LEGACY_IMPORT");
    expect(comparison.headerB.provenance).toBe("LEGACY_IMPORT");
    const row = comparison.articles.find((r) => r.articleId === article.id)!;
    expect(row.quantityA).toBe(8);
    expect(row.quantityB).toBe(10);
    expect(row.quantityDifference).toBe(2);
  });

  it("test 3: gebruikt ALTIJD de oorspronkelijke historische kostprijs van de legacy-rij, nooit de huidige levende kostprijs", () => {
    const article = makeArticle("A1", { costPrice: 999 }); // intussen compleet gewijzigde huidige kostprijs
    const articlesById = new Map([[article.id, article]]);
    const entries = [makeLegacyHistoryEntry("30/06/2026", "2026-06-30", article.id, "A1", { totalCount: 4, costPrice: 12.5 })];
    const snapshot = buildLegacyPeriodSnapshot("legacy:2026-06-30", "30/06/2026", "2026-06-30", entries, articlesById);

    const row = snapshot.articles.find((a) => a.articleId === article.id)!;
    expect(row.costPrice).toBe(12.5); // bevroren historische kostprijs
    expect(row.amount).toBe(50); // 4 x 12.5, nooit herberekend met de huidige 999
    expect(row.article.costPrice).toBe(999); // het onderliggende (huidige) Article-record blijft zelf ongewijzigd
  });

  it("test 4: Productgamma wordt canoniek/retroactief opgelost via categoryResolution, nooit via de bevroren bron-productgroep", () => {
    const article = makeArticle("A1", { productGroup: "HUIDIGE GROEP" });
    const articlesById = new Map([[article.id, article]]);
    const inputA = makeLegacyInput(
      "30/06/2026",
      "2026-06-30",
      [makeLegacyHistoryEntry("30/06/2026", "2026-06-30", article.id, "A1", { sourceProductGroup: "OUDE BRON GROEP" })],
      articlesById,
    );
    const snapB = makeSnapshot("s-b", "2026-09 Maand", [makeRow(article, { quantity: 5 })]);
    const inputB = makeInput("s-b", "2026-09 Maand", snapB);
    const categoryResolution = resolution({ [article.id]: "Kabels" }); // de HUIDIGE, canonieke categorie

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), categoryResolution);

    const row = comparison.articles.find((r) => r.articleId === article.id)!;
    // Canoniek/retroactief (spec: expliciet toegestaan) — nooit "OUDE BRON GROEP" of "HUIDIGE GROEP".
    expect(row.productCategory).toBe("Kabels");
  });

  it("test 5: ontbrekende legacy-waarden (hoeveelheid/kostprijs) blijven onbekend, worden nooit fictief 0", () => {
    const article = makeArticle("A1");
    const articlesById = new Map([[article.id, article]]);
    const inputA = makeLegacyInput(
      "30/06/2026",
      "2026-06-30",
      [makeLegacyHistoryEntry("30/06/2026", "2026-06-30", article.id, "A1", { totalCount: null, costPrice: null })],
      articlesById,
    );
    const snapB = makeSnapshot("s-b", "2026-09 Maand", [makeRow(article, { quantity: 5 })]);
    const inputB = makeInput("s-b", "2026-09 Maand", snapB);
    const categoryResolution = resolution({ [article.id]: "G1" });

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB), categoryResolution);

    const row = comparison.articles.find((r) => r.articleId === article.id)!;
    expect(row.quantityA).toBeNull();
    expect(row.costPriceA).toBeNull();
    expect(row.stockValueA).toBeNull();
    // Enkel gekend wanneer BEIDE kanten gekend zijn — nooit fictief 0/berekend met een ontbrekende zijde.
    expect(row.quantityDifference).toBeNull();
    expect(row.valueDifference).toBeNull();
    expect(row.priceDifferencePerUnit).toBeNull();
  });

  it("test 6: een legacy periode draagt nooit fysiek-getelde metadata bij aan de opeenvolgende-tellingen-keten", () => {
    const article = makeArticle("A1");
    const articlesById = new Map([[article.id, article]]);
    const legacyOld = makeLegacyHistoryEntry("31/03/2026", "2026-03-31", article.id, "A1", { totalCount: 10 });
    const legacyMid = makeLegacyHistoryEntry("30/06/2026", "2026-06-30", article.id, "A1", { totalCount: 10 });
    const inputA = makeLegacyInput("30/06/2026", "2026-06-30", [legacyMid], articlesById);
    // B is een ECHTE, fysiek getelde app-sessie met dezelfde hoeveelheid (10) —
    // de keten (B, legacyMid, legacyOld) is dus 3 opeenvolgend-ongewijzigd,
    // maar ENKEL B mag als "fysiek geteld" meetellen.
    const snapB = makeSnapshot("s-b", "2026-09 Maand", [makeRow(article, { quantity: 10, status: "GETELD" })]);
    const inputB = makeInput("s-b", "2026-09 Maand", snapB);
    const history: ReliableHistoryEntry[] = [
      {
        sessionId: inputB.sessionId,
        sessionName: inputB.sessionName,
        articlesById: new Map([[article.id, { totalCount: 10, status: "GETELD" as const }]]),
      },
      {
        sessionId: inputA.sessionId,
        sessionName: inputA.sessionName,
        articlesById: new Map(inputA.snapshot.articles.map((a) => [a.articleId, { totalCount: a.totalCount, status: a.status }])),
      },
      {
        sessionId: "legacy:2026-03-31",
        sessionName: legacyOld.sessionName,
        articlesById: new Map([[article.id, { totalCount: legacyOld.totalCount, status: legacyOld.status }]]),
      },
    ];
    const categoryResolution = resolution({ [article.id]: "G1" });

    const comparison = buildSessionComparison(inputA, inputB, history, categoryResolution);

    const row = comparison.articles.find((r) => r.articleId === article.id)!;
    expect(row.consecutiveUnchangedCount).toBe(3);
    // Geen enkele gefabriceerde telkwaliteit voor de 2 legacy-periodes in de
    // keten: enkel de ene ECHTE app-sessie (B) telt mee als "fysiek geteld".
    expect(row.consecutiveUnchangedPhysicallyCountedCount).toBe(1);
    expect(row.isObsoleteCandidate).toBe(true);
  });
});
