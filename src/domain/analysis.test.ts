import { describe, expect, it } from "vitest";
import {
  BIG_DEVIATION_THRESHOLD_EUR,
  buildDeviationAnalysis,
  buildSessionAnalysis,
  filterAnalysisArticles,
  sortAnalysisArticles,
  DEFAULT_ANALYSIS_ARTICLE_FILTERS,
  type AnalysisArticleRow,
} from "./analysis";
import { computeSessionReview } from "./review";
import { buildSessionSnapshot } from "./stockSnapshot";
import type { Article, CountEntry, CountSession, Location } from "./types";

/**
 * Sprint 2 — Historical Count Analysis. Zelfde fixture-stijl als
 * stockSnapshot.test.ts: een echte `computeSessionReview` +
 * `buildSessionSnapshot`-pijplijn i.p.v. handgeschreven `ArticleSnapshot`-
 * literalen — zo test dit bestand `buildSessionAnalysis` tegen exact het
 * soort bevroren data dat `CountSessionService#finalize` ook echt
 * produceert, niet tegen een losstaande aanname over de vorm ervan.
 */

const locations: Location[] = [
  { id: "office:loc-1", officeId: "office", number: 1, name: "Rek 1", active: true },
  { id: "office:loc-2", officeId: "office", number: 2, name: "Rek 2", active: true },
];

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return {
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
    previousCount: 10,
    sourceRow: 1,
    ...overrides,
  };
}

function makeEntry(articleId: string, locationId: string | null, overrides: Partial<CountEntry> = {}): CountEntry {
  return {
    id: `session-1:${articleId}:${locationId ?? "absent"}`,
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

function makeSession(overrides: Partial<CountSession> = {}): CountSession {
  return {
    id: "session-1",
    officeId: "office",
    type: "MONTHLY",
    status: "COMPLETED",
    startedAt: "2026-09-01T08:00:00.000Z",
    completedAt: "2026-09-30T15:00:00.000Z",
    sourceFileName: "test.xlsx",
    sourceBaseDate: "2026-09-01",
    articleIds: [],
    ...overrides,
  };
}

/** Bouwt de volledige, echte pijplijn (review -> snapshot -> analyse) uit ruwe fixtures. */
function analyze(articles: Article[], entries: CountEntry[], session: CountSession) {
  const review = computeSessionReview(session, articles, locations, entries);
  const snapshot = buildSessionSnapshot(session, articles, review);
  return buildSessionAnalysis(snapshot, review, locations);
}

describe("buildSessionAnalysis — KPI's en voorraadwaarde (spec §2/§3)", () => {
  it("berekent voorraadwaarde als eindsnapshot-hoeveelheid × historische kostprijs, nooit vermengd met correctiewaarde", () => {
    const a1 = makeArticle("A1", { costPrice: 10, previousCount: 5 });
    const a2 = makeArticle("A2", { costPrice: 4, previousCount: 2 });
    const session = makeSession({ articleIds: ["office:A1", "office:A2"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 8, counted: true }),
      makeEntry("office:A2", null, { quantity: 0, counted: true, resolution: "CONFIRMED_ABSENT" }),
    ];

    const analysis = analyze([a1, a2], entries, session);

    // A1: GETELD, 8 stuks x €10 = €80 voorraadwaarde, verschil (8-5)*10 = +€30.
    // A2: 0 BEVESTIGD, 0 stuks x €4 = €0 voorraadwaarde, verschil (0-2)*4 = -€8.
    expect(analysis.kpis.totalStockValue).toBe(80);
    expect(analysis.kpis.physicallyCountedArticles).toBe(1);
    expect(analysis.kpis.confirmedZeroArticles).toBe(1);
    expect(analysis.kpis.carriedOverArticles).toBe(0);
    expect(analysis.kpis.carriedOverNotCountedArticles).toBe(0);
    expect(analysis.kpis.positiveCorrectionAmount).toBe(30);
    expect(analysis.kpis.negativeCorrectionAmount).toBe(-8);
    expect(analysis.kpis.netCorrectionAmount).toBe(22);
    expect(analysis.kpis.articlesWithDifference).toBe(2);
  });

  it("een artikel buiten de sessiescope (OVERGENOMEN) draagt zijn vorige waarde bij, nooit €0", () => {
    const monthly = makeArticle("A1", { costPrice: 10, previousCount: 5, countPeriod: "MONTHLY" });
    const quarterly = makeArticle("Q1", {
      costPrice: 50,
      previousCount: 6,
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
    });
    const session = makeSession({ articleIds: ["office:A1"] }); // enkel A1 in scope (MONTHLY)
    const entries: CountEntry[] = [makeEntry("office:A1", "office:loc-1", { quantity: 5, counted: true })];

    const analysis = analyze([monthly, quarterly], entries, session);

    expect(analysis.kpis.carriedOverArticles).toBe(1);
    // 5*10 (A1, ongewijzigd) + 6*50 (Q1, overgenomen) = 350.
    expect(analysis.kpis.totalStockValue).toBe(350);
    const q1Row = analysis.articles.find((r) => r.articleId === "office:Q1");
    expect(q1Row?.status).toBe("OVERGENOMEN");
    expect(q1Row?.stockValue).toBe(300);
    // OVERGENOMEN is per definitie NOOIT een verschil (spec: "nooit fictief 0 -> nu wel altijd exact 0 verschil").
    expect(q1Row?.differenceQuantity).toBe(0);
  });

  it("onbekende kostprijs/hoeveelheid wordt veilig (nooit als €0 verborgen) geteld in articlesWithUnknownValue", () => {
    const article = makeArticle("A1", { costPrice: null, previousCount: null });
    const session = makeSession({ articleIds: ["office:A1"] });
    const analysis = analyze([article], [], session);

    // Nooit geteld, geen kostprijs: OVERGENOMEN met previousCount null -> amount null.
    expect(analysis.kpis.totalStockValue).toBe(0);
    expect(analysis.kpis.articlesWithUnknownValue).toBe(1);
  });
});

describe("buildSessionAnalysis — voorraadwaarde per productgroep (spec §4)", () => {
  it("groepeert per productgroep, sorteert op hoogste voorraadwaarde eerst, en berekent het percentage van het totaal", () => {
    const a1 = makeArticle("A1", { productGroup: "Batterijen", costPrice: 10, previousCount: 0 });
    const a2 = makeArticle("A2", { productGroup: "Batterijen", costPrice: 5, previousCount: 0 });
    const a3 = makeArticle("A3", { productGroup: "Zonnepanelen", costPrice: 100, previousCount: 0 });
    const session = makeSession({ articleIds: ["office:A1", "office:A2", "office:A3"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 10, counted: true }), // 100
      makeEntry("office:A2", "office:loc-1", { quantity: 4, counted: true }), // 20
      makeEntry("office:A3", "office:loc-1", { quantity: 2, counted: true }), // 200
    ];

    const analysis = analyze([a1, a2, a3], entries, session);

    expect(analysis.kpis.totalStockValue).toBe(320);
    expect(analysis.productGroups.map((g) => g.productGroup)).toEqual(["Zonnepanelen", "Batterijen"]);
    const zonnepanelen = analysis.productGroups.find((g) => g.productGroup === "Zonnepanelen")!;
    expect(zonnepanelen.articleCount).toBe(1);
    expect(zonnepanelen.stockValue).toBe(200);
    expect(zonnepanelen.percentOfTotalStockValue).toBeCloseTo(62.5, 5);
    const batterijen = analysis.productGroups.find((g) => g.productGroup === "Batterijen")!;
    expect(batterijen.articleCount).toBe(2);
    expect(batterijen.stockValue).toBe(120);
    expect(batterijen.totalUnits).toBe(14);
  });

  it("een artikel zonder productgroep valt onder een expliciete, nooit-lege groepslabel", () => {
    const article = makeArticle("A1", { productGroup: null, costPrice: 1, previousCount: 0 });
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [makeEntry("office:A1", "office:loc-1", { quantity: 1, counted: true })];

    const analysis = analyze([article], entries, session);

    expect(analysis.productGroups).toHaveLength(1);
    expect(analysis.productGroups[0].productGroup).toBe("(geen productgroep)");
  });
});

describe("buildSessionAnalysis — obsolete voorraad (spec §5-6)", () => {
  it("berekent obsolete totalen/percentage/breakdown enkel voor OBSOLETE-geclassificeerde artikelen", () => {
    const active = makeArticle("A1", {
      productGroup: "G1",
      costPrice: 10,
      previousCount: 0,
      stockClassification: "ACTIVE",
    });
    const obsoleteCheap = makeArticle("A2", {
      productGroup: "G1",
      costPrice: 5,
      previousCount: 0,
      stockClassification: "OBSOLETE",
    });
    const obsoleteExpensive = makeArticle("A3", {
      productGroup: "G2",
      costPrice: 50,
      previousCount: 0,
      stockClassification: "OBSOLETE",
    });
    const session = makeSession({ articleIds: ["office:A1", "office:A2", "office:A3"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 10, counted: true }), // 100 (ACTIEF)
      makeEntry("office:A2", "office:loc-1", { quantity: 4, counted: true }), // 20 (OBSOLETE)
      makeEntry("office:A3", "office:loc-1", { quantity: 2, counted: true }), // 100 (OBSOLETE)
    ];

    const analysis = analyze([active, obsoleteCheap, obsoleteExpensive], entries, session);

    expect(analysis.kpis.totalStockValue).toBe(220);
    expect(analysis.obsolete.totalObsoleteValue).toBe(120);
    expect(analysis.obsolete.percentOfTotalStockValue).toBeCloseTo((120 / 220) * 100, 5);
    expect(analysis.obsolete.obsoleteArticleCount).toBe(2);
    expect(analysis.obsolete.obsoleteTotalUnits).toBe(6);
    // Sortering: hoogste obsolete waarde eerst.
    expect(analysis.obsolete.articles.map((a) => a.articleId)).toEqual(["office:A3", "office:A2"]);
    expect(analysis.obsolete.byProductGroup).toHaveLength(2);
  });

  it("een artikel zonder expliciete `stockClassification` (legacy, van vóór deze sprint) telt veilig als ACTIVE", () => {
    // `stockClassification` bewust weggelaten -> `undefined`, exact zoals een Article van vóór Sprint 2.
    const legacyArticle = makeArticle("A1", { costPrice: 100, previousCount: 0 });
    delete (legacyArticle as { stockClassification?: unknown }).stockClassification;
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [makeEntry("office:A1", "office:loc-1", { quantity: 1, counted: true })];

    const analysis = analyze([legacyArticle], entries, session);

    expect(analysis.obsolete.obsoleteArticleCount).toBe(0);
    expect(analysis.articles[0].classification).toBe("ACTIVE");
  });
});

describe("buildSessionAnalysis — telkwaliteit/volledigheid (spec §7)", () => {
  it("berekent percentPhysicallyResolved over de sessiescope, en telt handmatige buiten-scope-toevoegingen als nieuwe artikelen", () => {
    const a1 = makeArticle("A1", { previousCount: 0 });
    const a2 = makeArticle("A2", { previousCount: 0 });
    const manual = makeArticle("M1", { previousCount: null });
    const session = makeSession({ articleIds: ["office:A1", "office:A2"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 1, counted: true }),
      // A2 blijft ongeteld (geen entry) -> OVERGENOMEN - NIET GETELD (geforceerde afronding).
      makeEntry("office:M1", "office:loc-2", { quantity: 3, counted: true }), // buiten scope -> handmatige toevoeging
    ];

    const analysis = analyze([a1, a2, manual], entries, session);

    // `physicallyCountedArticles` telt over de VOLLEDIGE snapshot (spec §2: dit
    // is dezelfde teller als de "GETELD"-status in de voorraad-snapshot), dus
    // inclusief de handmatige buiten-scope-toevoeging M1 — enkel
    // `percentPhysicallyResolved` hieronder is scope-beperkt (spec §7: "over
    // de sessiescope").
    expect(analysis.countingQuality.physicallyCountedArticles).toBe(2); // A1 + M1
    expect(analysis.countingQuality.carriedOverNotCountedArticles).toBe(1); // A2
    expect(analysis.countingQuality.percentPhysicallyResolved).toBeCloseTo(50, 5); // 1 van 2 scope-artikelen
    expect(analysis.countingQuality.newArticlesFound).toBe(1); // M1
  });
});

describe("buildSessionAnalysis — grootste afwijkingen (spec §8)", () => {
  it("sorteert negatief/positief apart op financiële impact, en 'all' op absolute impact", () => {
    const articles = [
      makeArticle("A1", { costPrice: 1, previousCount: 0 }), // +5
      makeArticle("A2", { costPrice: 1, previousCount: 20 }), // -20 (grootste negatieve impact)
      makeArticle("A3", { costPrice: 1, previousCount: 0 }), // +50 (grootste positieve impact)
      makeArticle("A4", { costPrice: 1, previousCount: 3 }), // -3
    ];
    const session = makeSession({ articleIds: articles.map((a) => a.id) });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 5, counted: true }),
      makeEntry("office:A2", "office:loc-1", { quantity: 0, counted: true }),
      makeEntry("office:A3", "office:loc-1", { quantity: 50, counted: true }),
      makeEntry("office:A4", "office:loc-1", { quantity: 0, counted: true }),
    ];

    const analysis = analyze(articles, entries, session);

    expect(analysis.deviations.biggestNegative.map((d) => d.articleId)).toEqual(["office:A2", "office:A4"]);
    expect(analysis.deviations.biggestPositive.map((d) => d.articleId)).toEqual(["office:A3", "office:A1"]);
    expect(analysis.deviations.all.map((d) => d.articleId)).toEqual([
      "office:A3",
      "office:A2",
      "office:A1",
      "office:A4",
    ]);
  });

  it("respecteert de limiet voor biggestNegative/biggestPositive, maar 'all' blijft volledig", () => {
    const rows: AnalysisArticleRow[] = Array.from({ length: 15 }, (_, i) => ({
      articleId: `a${i}`,
      articleNumber: `A${i}`,
      description: `Artikel ${i}`,
      productGroup: null,
      classification: "ACTIVE",
      unit: null,
      previousCount: 0,
      finalQuantity: i + 1,
      differenceQuantity: i + 1,
      costPrice: 1,
      stockValue: i + 1,
      correctionAmount: i + 1,
      status: "GETELD",
      physicallyCounted: true,
    }));
    const result = buildDeviationAnalysis(rows, 10);
    expect(result.biggestPositive).toHaveLength(10);
    expect(result.all).toHaveLength(15);
  });
});

describe("buildSessionAnalysis — analyse per locatie (spec §9, geen dubbeltelling van geld)", () => {
  it("telt fysiek geteld/verschil/stuks per locatie zonder een €-veld te verzinnen", () => {
    const a1 = makeArticle("A1", { costPrice: 10, previousCount: 5 });
    const a2 = makeArticle("A2", { costPrice: 10, previousCount: 5 });
    const session = makeSession({ articleIds: ["office:A1", "office:A2"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 8, counted: true }),
      makeEntry("office:A2", "office:loc-2", { quantity: 5, counted: true }), // geen verschil
    ];

    const analysis = analyze([a1, a2], entries, session);

    const loc1 = analysis.locations.find((l) => l.locationId === "office:loc-1")!;
    const loc2 = analysis.locations.find((l) => l.locationId === "office:loc-2")!;
    expect(loc1.physicallyCountedArticles).toBe(1);
    expect(loc1.articlesWithDifference).toBe(1);
    expect(loc1.totalUnitsCounted).toBe(8);
    expect(loc2.physicallyCountedArticles).toBe(1);
    expect(loc2.articlesWithDifference).toBe(0);
    // Geen enkel geld-/waardeveld op dit type — TypeScript garandeert dit al,
    // maar we controleren hier expliciet dat de runtime-rij dat ook nooit bevat.
    expect(loc1).not.toHaveProperty("correctionAmount");
    expect(loc1).not.toHaveProperty("stockValue");
  });
});

describe("buildSessionAnalysis — aandachtspunten (spec §10, regelgebaseerd, geen verzonnen metrieken)", () => {
  it("toont enkel items die uit de bevroren data reconstrueerbaar zijn", () => {
    const bigDeviationArticle = makeArticle("A1", {
      costPrice: 1000,
      previousCount: 10,
      productGroup: "G1",
      stockClassification: "OBSOLETE",
    });
    const session = makeSession({ articleIds: ["office:A1"] });
    // Geforceerd afgerond zonder deze te tellen -> "niet fysiek geteld" + OVERGENOMEN - NIET GETELD.
    const analysis = analyze([bigDeviationArticle], [], session);

    const kinds = analysis.attentionPoints.map((p) => p.kind);
    expect(kinds).toContain("NOT_COUNTED");
    expect(kinds).toContain("OBSOLETE_VALUE");
    // Geen "onverwachte locatie"-metriek: die kan niet betrouwbaar uit bevroren data afgeleid worden (spec §7/§10).
    expect(kinds).not.toContain("UNEXPECTED_LOCATION");
  });

  it("meldt een grote afwijking enkel boven de drempel", () => {
    const smallDeviation = makeArticle("A1", { costPrice: 1, previousCount: 0 }); // +€10
    const bigDeviation = makeArticle("A2", { costPrice: 1000, previousCount: 0 }); // +€1000
    const session = makeSession({ articleIds: ["office:A1", "office:A2"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 10, counted: true }),
      makeEntry("office:A2", "office:loc-1", { quantity: 1, counted: true }),
    ];

    const analysis = analyze([smallDeviation, bigDeviation], entries, session);
    expect(BIG_DEVIATION_THRESHOLD_EUR).toBe(500);
    const point = analysis.attentionPoints.find((p) => p.kind === "BIG_DEVIATION");
    expect(point?.label).toContain("1 afwijking");
  });
});

describe("buildSessionAnalysis — historische onveranderlijkheid (spec §13/§17)", () => {
  it("een latere (immutabele) wijziging aan een artikelobject beïnvloedt een reeds gebouwde analyse nooit", () => {
    const article = makeArticle("A1", { costPrice: 10, previousCount: 0, productGroup: "Oud" });
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [makeEntry("office:A1", "office:loc-1", { quantity: 5, counted: true })];

    const review = computeSessionReview(session, [article], locations, entries);
    const snapshot = buildSessionSnapshot(session, [article], review);
    const analysisBefore = buildSessionAnalysis(snapshot, review, locations);

    // Simuleer een latere, immutabele bewerking (exact zoals ArticleDetailPage
    // dat doet: een NIEUW object via spread, nooit een mutatie van het
    // bestaande object) — dit object wordt NERGENS aan de reeds bevroren
    // `snapshot` doorgegeven.
    const laterEdit: Article = { ...article, costPrice: 999, productGroup: "Nieuw", stockClassification: "OBSOLETE" };
    expect(laterEdit.costPrice).toBe(999); // enkel om te bevestigen dat de "latere editie" zelf wél wijzigde...

    // ...maar een analyse herbouwd uit de ORIGINELE, ongewijzigde snapshot
    // blijft exact hetzelfde, ongeacht wat er met `laterEdit` gebeurt.
    const analysisAfter = buildSessionAnalysis(snapshot, review, locations);
    expect(analysisAfter).toEqual(analysisBefore);
    expect(analysisAfter.kpis.totalStockValue).toBe(50);
    expect(analysisAfter.productGroups[0].productGroup).toBe("Oud");
    expect(analysisAfter.obsolete.obsoleteArticleCount).toBe(0);
  });
});

describe("filterAnalysisArticles / sortAnalysisArticles (spec §11)", () => {
  const rows: AnalysisArticleRow[] = [
    {
      articleId: "a1",
      articleNumber: "A1",
      description: "Zonnepaneel 300W",
      productGroup: "Zonnepanelen",
      classification: "ACTIVE",
      unit: null,
      previousCount: 5,
      finalQuantity: 8,
      differenceQuantity: 3,
      costPrice: 10,
      stockValue: 80,
      correctionAmount: 30,
      status: "GETELD",
      physicallyCounted: true,
    },
    {
      articleId: "a2",
      articleNumber: "A2",
      description: "Batterij 5kWh",
      productGroup: "Batterijen",
      classification: "OBSOLETE",
      unit: null,
      previousCount: 2,
      finalQuantity: 2,
      differenceQuantity: 0,
      costPrice: 500,
      stockValue: 1000,
      correctionAmount: 0,
      status: "OVERGENOMEN",
      physicallyCounted: false,
    },
  ];

  it("filtert op productgroep, classificatie, verschil en telstatus", () => {
    expect(filterAnalysisArticles(rows, { ...DEFAULT_ANALYSIS_ARTICLE_FILTERS, productGroup: "Batterijen" })).toEqual([
      rows[1],
    ]);
    expect(
      filterAnalysisArticles(rows, { ...DEFAULT_ANALYSIS_ARTICLE_FILTERS, classification: "OBSOLETE" }),
    ).toEqual([rows[1]]);
    expect(
      filterAnalysisArticles(rows, { ...DEFAULT_ANALYSIS_ARTICLE_FILTERS, onlyWithDifference: true }),
    ).toEqual([rows[0]]);
    expect(
      filterAnalysisArticles(rows, { ...DEFAULT_ANALYSIS_ARTICLE_FILTERS, countingState: "PHYSICALLY_COUNTED" }),
    ).toEqual([rows[0]]);
    expect(
      filterAnalysisArticles(rows, { ...DEFAULT_ANALYSIS_ARTICLE_FILTERS, search: "batterij" }),
    ).toEqual([rows[1]]);
  });

  it("sorteert op voorraadwaarde of correctiebedrag, hoog naar laag", () => {
    const byValue = sortAnalysisArticles(rows, "STOCK_VALUE_DESC");
    expect(byValue.map((r) => r.articleId)).toEqual(["a2", "a1"]);
    const byCorrection = sortAnalysisArticles(rows, "CORRECTION_AMOUNT_DESC");
    expect(byCorrection.map((r) => r.articleId)).toEqual(["a1", "a2"]);
  });
});
