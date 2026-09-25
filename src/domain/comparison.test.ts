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
import type { ArticleSnapshot, ArticleSnapshotStatus, StockSnapshot } from "./stockSnapshot";
import type { Article } from "./types";

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
  it("berekent totale stockwaarde A/B, delta €, delta % en productgroeptotalen correct", () => {
    const a1 = makeArticle("A1", { productGroup: "G1", costPrice: 2 });
    const a2 = makeArticle("A2", { productGroup: "G2", costPrice: 10, stockClassification: "OBSOLETE" });

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

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));

    expect(comparison.kpis.stockValue.valueA).toBe(70);
    expect(comparison.kpis.stockValue.valueB).toBe(80);
    expect(comparison.kpis.stockValue.differenceAmount).toBe(10);
    expect(comparison.kpis.stockValue.differencePercent).toBeCloseTo((10 / 70) * 100, 5);

    expect(comparison.kpis.obsolete.valueA).toBe(50);
    expect(comparison.kpis.obsolete.valueB).toBe(50);
    expect(comparison.kpis.obsolete.differenceAmount).toBe(0);

    const g1 = comparison.productGroups.find((g) => g.productGroup === "G1");
    const g2 = comparison.productGroups.find((g) => g.productGroup === "G2");
    expect(g1?.valueA).toBe(20);
    expect(g1?.valueB).toBe(30);
    expect(g1?.valueDifference).toBe(10);
    expect(g2?.valueDifference).toBe(0);
    // Default sortering: grootste absolute verandering eerst.
    expect(comparison.productGroups[0].productGroup).toBe("G1");
  });

  it("differencePercent is null wanneer de basiswaarde (A) 0 is — nooit fictief 0% of Infinity", () => {
    const a1 = makeArticle("A1", { costPrice: 5 });
    const snapA = makeSnapshot("s-a", "A", [makeRow(a1, { quantity: 0 })]);
    const snapB = makeSnapshot("s-b", "B", [makeRow(a1, { quantity: 3 })]);
    const inputA = makeInput("s-a", "A", snapA);
    const inputB = makeInput("s-b", "B", snapB);

    const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));
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
  const comparison = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));
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
    const cmp = buildSessionComparison(inputA2, inputB2, historyWithOnlyB(inputB2));
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
    const cmp = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));
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
    const cmp = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));
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
    const cmp = buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));
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
    return buildSessionComparison(inputA, inputB, history);
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
    buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB));
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
    return buildSessionComparison(inputA, inputB, historyWithOnlyB(inputB)).articles[0];
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

describe("Filters/sortering van de volledige detailtabel (spec §12)", () => {
  const rows: ArticleComparisonRow[] = [
    {
      articleId: "1",
      articleNumber: "N1",
      description: "Beta artikel",
      productGroup: "G1",
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

  it("filtert op productgroep en zoekterm", () => {
    expect(filterArticleComparisonRows(rows, { ...DEFAULT_ARTICLE_COMPARISON_FILTERS, productGroup: "G2" })).toHaveLength(1);
    expect(filterArticleComparisonRows(rows, { ...DEFAULT_ARTICLE_COMPARISON_FILTERS, search: "beta" })).toHaveLength(1);
  });

  it("sorteert op grootste waardeverschil en op omschrijving", () => {
    const byValue = sortArticleComparisonRows(rows, "VALUE_DIFF_DESC");
    expect(byValue[0].articleNumber).toBe("N2");
    const byDescription = sortArticleComparisonRows(rows, "DESCRIPTION");
    expect(byDescription[0].articleNumber).toBe("N2"); // "Alfa" < "Beta"
  });
});
