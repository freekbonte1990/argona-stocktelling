import type { SessionReviewSummary } from "./review";
import { PRODUCT_CATEGORY_FALLBACK } from "./productCategory";
import type { ArticleCategoryResolution } from "./productCategory";
import { getStockClassification } from "./stockClassification";
import type { ArticleSnapshot, ArticleSnapshotStatus, StockSnapshot } from "./stockSnapshot";
import type { CountSessionType, Location, StockClassification } from "./types";

/**
 * Sprint 2 — Historical Count Analysis. PURE domeinlogica voor de
 * "Analyse telling"-view van een AFGERONDE sessie: alle berekeningen hier
 * werken uitsluitend op reeds bevroren gegevens (`StockSnapshot` +
 * `SessionReviewSummary`, zoals bewaard in `FinalizedSessionResult` — zie
 * `application/ports/CountingRepository.ts`). Geen React, geen Excel, geen
 * IndexedDB, en bewust GEEN import van `application/`: domain/ mag nooit
 * van application/ afhangen (zie docs/ARCHITECTURE.md).
 *
 * KERNREGEL (spec §3/§13): dit bestand leest NOOIT live `Article`-data —
 * elke `ArticleSnapshot.article` binnen `StockSnapshot` is al een bevroren
 * kopie op het moment dat de sessie werd afgerond (`buildSessionSnapshot`
 * in stockSnapshot.ts). Een latere kostprijs-/productgroep-/classificatie-
 * wijziging aan het levende artikel raakt deze berekeningen dus nooit —
 * dat is precies wat de historische correctheid van deze module garandeert.
 *
 * KERNREGEL 2 (spec §2, "kritiek onderscheid"): "voorraadwaarde" en
 * "correctiewaarde" zijn twee verschillende dingen. `ArticleSnapshot.amount`
 * is al exact "eindsnapshot-hoeveelheid × historische kostprijs" voor ALLE
 * vier statussen (zie `stockSnapshot.ts#buildArticleSnapshot`: voor GETELD/
 * 0 BEVESTIGD is dat `newTotalCount * costPrice`, voor OVERGENOMEN(-NIET
 * GETELD) is dat `previousValue = previousCount * costPrice`) — dit bestand
 * hergebruikt dat veld dus rechtstreeks voor "voorraadwaarde", en
 * `ArticleSnapshot.differenceAmount` voor "correctiewaarde". Nooit door
 * elkaar gehaald.
 */

// ---------------------------------------------------------------------------
// Basisrij: één artikel binnen de analyse (basis voor KPI's, groepen, lijst)
// ---------------------------------------------------------------------------

export interface AnalysisArticleRow {
  articleId: string;
  articleNumber: string;
  description: string;
  /** Sprint 3.2 §2: "Bronproductgroep" — bevroren op het moment van de snapshot, puur audit/naslag. Nooit meer gebruikt voor groepering/analyse. */
  productGroup: string | null;
  /** Sprint 3.2 §11 (kritiek): de HUIDIGE, canonieke "Productgamma"-id — geresolveerd t.o.v. de LEVENDE artikelstam op het moment dat deze analyse opgebouwd wordt, nooit bevroren. `null` = niet ingedeeld. */
  productCategoryId: string | null;
  /** Weergavenaam van `productCategoryId`, met fallback `PRODUCT_CATEGORY_FALLBACK` — dit is het veld waarop gegroepeerd/gefilterd wordt. */
  productCategory: string;
  classification: StockClassification;
  unit: string | null;
  /** "Vorige telling" op het moment van deze snapshot. */
  previousCount: number | null;
  /** "Nieuwe telling"/eindsnapshot-hoeveelheid — null enkel wanneer nog nooit een geldige fysieke telling gekend was. */
  finalQuantity: number | null;
  differenceQuantity: number | null;
  costPrice: number | null;
  /** Voorraadwaarde = eindsnapshot-hoeveelheid × historische kostprijs (`ArticleSnapshot.amount`). */
  stockValue: number | null;
  /** Correctiewaarde = verschil t.o.v. vorige telling × historische kostprijs (`ArticleSnapshot.differenceAmount`). */
  correctionAmount: number | null;
  status: ArticleSnapshotStatus;
  /** GETELD of "0 BEVESTIGD" deze sessie. */
  physicallyCounted: boolean;
}

/**
 * Sprint 3 (Vergelijking tussen stocktellingen): geëxporteerd zodat
 * `domain/comparison.ts` exact dezelfde, al bestaande vertaling van een
 * bevroren `ArticleSnapshot` naar een analyse-rij kan hergebruiken (zelfde
 * classificatie-/waardeberekening als hierboven) i.p.v. die te dupliceren.
 * Puur een export van een reeds bestaande, ongewijzigde functie — geen
 * enkele bestaande aanroeper/uitvoer hier verandert hierdoor.
 */
export function toAnalysisArticleRow(
  snapshotRow: ArticleSnapshot,
  categoryResolution: Map<string, ArticleCategoryResolution>,
): AnalysisArticleRow {
  const { article } = snapshotRow;
  const resolution = categoryResolution.get(snapshotRow.articleId);
  return {
    articleId: snapshotRow.articleId,
    articleNumber: article.articleNumber,
    description: article.description,
    productGroup: article.productGroup,
    productCategoryId: resolution?.categoryId ?? null,
    productCategory: resolution?.categoryName ?? PRODUCT_CATEGORY_FALLBACK,
    classification: getStockClassification(article),
    unit: article.unit,
    previousCount: snapshotRow.previousCount,
    finalQuantity: snapshotRow.totalCount,
    differenceQuantity: snapshotRow.differenceQuantity,
    costPrice: snapshotRow.costPrice,
    stockValue: snapshotRow.amount,
    correctionAmount: snapshotRow.differenceAmount,
    status: snapshotRow.status,
    physicallyCounted: snapshotRow.status === "GETELD" || snapshotRow.status === "0 BEVESTIGD",
  };
}

function percentOf(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

// ---------------------------------------------------------------------------
// KPI's (spec §2)
// ---------------------------------------------------------------------------

export interface SessionAnalysisKpis {
  totalStockValue: number;
  articlesInScope: number;
  physicallyCountedArticles: number;
  confirmedZeroArticles: number;
  carriedOverArticles: number;
  carriedOverNotCountedArticles: number;
  articlesWithDifference: number;
  positiveCorrectionAmount: number;
  negativeCorrectionAmount: number;
  netCorrectionAmount: number;
  /** Aantal artikelen waarvoor de voorraadwaarde niet gekend is (kostprijs of hoeveelheid onbekend) — spec §17: "veilig en expliciet". */
  articlesWithUnknownValue: number;
}

function computeKpis(rows: AnalysisArticleRow[], review: SessionReviewSummary): SessionAnalysisKpis {
  let totalStockValue = 0;
  let physicallyCountedArticles = 0;
  let confirmedZeroArticles = 0;
  let carriedOverArticles = 0;
  let carriedOverNotCountedArticles = 0;
  let articlesWithDifference = 0;
  let positiveCorrectionAmount = 0;
  let negativeCorrectionAmount = 0;
  let articlesWithUnknownValue = 0;

  for (const row of rows) {
    if (row.stockValue !== null) {
      totalStockValue += row.stockValue;
    } else {
      articlesWithUnknownValue += 1;
    }
    switch (row.status) {
      case "GETELD":
        physicallyCountedArticles += 1;
        break;
      case "0 BEVESTIGD":
        confirmedZeroArticles += 1;
        break;
      case "OVERGENOMEN":
        carriedOverArticles += 1;
        break;
      case "OVERGENOMEN - NIET GETELD":
        carriedOverNotCountedArticles += 1;
        break;
    }
    if (row.differenceQuantity !== null && row.differenceQuantity !== 0) {
      articlesWithDifference += 1;
    }
    if (row.correctionAmount !== null && row.correctionAmount !== 0) {
      if (row.correctionAmount > 0) positiveCorrectionAmount += row.correctionAmount;
      else negativeCorrectionAmount += row.correctionAmount;
    }
  }

  return {
    totalStockValue,
    articlesInScope: review.totalArticlesInScope,
    physicallyCountedArticles,
    confirmedZeroArticles,
    carriedOverArticles,
    carriedOverNotCountedArticles,
    articlesWithDifference,
    positiveCorrectionAmount,
    negativeCorrectionAmount,
    netCorrectionAmount: positiveCorrectionAmount + negativeCorrectionAmount,
    articlesWithUnknownValue,
  };
}

// ---------------------------------------------------------------------------
// Voorraadwaarde per productgamma (spec §4, sinds Sprint 3.2 §11: canoniek,
// retroactief — nooit meer de bevroren bronproductgroep)
// ---------------------------------------------------------------------------

export interface ProductCategoryAnalysisRow {
  /** Weergavenaam van de HUIDIGE canonieke Productgamma — "niet ingedeeld" wordt getoond als `PRODUCT_CATEGORY_FALLBACK`, nooit een lege string. */
  productCategory: string;
  articleCount: number;
  totalUnits: number;
  stockValue: number;
  positiveCorrectionAmount: number;
  negativeCorrectionAmount: number;
  netCorrectionAmount: number;
  percentOfTotalStockValue: number;
}

/** Standaard sortering (spec §4): hoogste voorraadwaarde eerst. */
export function buildProductCategoryAnalysis(
  rows: AnalysisArticleRow[],
  totalStockValue: number,
): ProductCategoryAnalysisRow[] {
  const byGroup = new Map<string, ProductCategoryAnalysisRow>();
  for (const row of rows) {
    const label = row.productCategory;
    let entry = byGroup.get(label);
    if (!entry) {
      entry = {
        productCategory: label,
        articleCount: 0,
        totalUnits: 0,
        stockValue: 0,
        positiveCorrectionAmount: 0,
        negativeCorrectionAmount: 0,
        netCorrectionAmount: 0,
        percentOfTotalStockValue: 0,
      };
      byGroup.set(label, entry);
    }
    entry.articleCount += 1;
    entry.totalUnits += row.finalQuantity ?? 0;
    entry.stockValue += row.stockValue ?? 0;
    if (row.correctionAmount !== null) {
      if (row.correctionAmount > 0) entry.positiveCorrectionAmount += row.correctionAmount;
      else if (row.correctionAmount < 0) entry.negativeCorrectionAmount += row.correctionAmount;
    }
  }
  const result = Array.from(byGroup.values());
  for (const entry of result) {
    entry.netCorrectionAmount = entry.positiveCorrectionAmount + entry.negativeCorrectionAmount;
    entry.percentOfTotalStockValue = percentOf(entry.stockValue, totalStockValue);
  }
  return result.sort((a, b) => b.stockValue - a.stockValue);
}

// ---------------------------------------------------------------------------
// Obsolete stock (spec §5-6)
// ---------------------------------------------------------------------------

export interface ObsoleteProductCategoryRow {
  productCategory: string;
  articleCount: number;
  totalUnits: number;
  obsoleteValue: number;
}

export interface ObsoleteArticleRow {
  articleId: string;
  articleNumber: string;
  description: string;
  /** Bronproductgroep (bevroren, audit) — zie `AnalysisArticleRow.productGroup`. */
  productGroup: string | null;
  /** Huidige canonieke Productgamma (weergavenaam). */
  productCategory: string;
  quantity: number | null;
  costPrice: number | null;
  stockValue: number | null;
}

export interface ObsoleteAnalysis {
  totalObsoleteValue: number;
  percentOfTotalStockValue: number;
  obsoleteArticleCount: number;
  obsoleteTotalUnits: number;
  byProductCategory: ObsoleteProductCategoryRow[];
  /** Sortering (spec §6): hoogste obsolete waarde eerst. */
  articles: ObsoleteArticleRow[];
}

export function buildObsoleteAnalysis(
  rows: AnalysisArticleRow[],
  totalStockValue: number,
): ObsoleteAnalysis {
  const obsoleteRows = rows.filter((row) => row.classification === "OBSOLETE");
  const totalObsoleteValue = obsoleteRows.reduce((sum, row) => sum + (row.stockValue ?? 0), 0);
  const obsoleteTotalUnits = obsoleteRows.reduce((sum, row) => sum + (row.finalQuantity ?? 0), 0);

  const byGroup = new Map<string, ObsoleteProductCategoryRow>();
  for (const row of obsoleteRows) {
    const label = row.productCategory;
    let entry = byGroup.get(label);
    if (!entry) {
      entry = { productCategory: label, articleCount: 0, totalUnits: 0, obsoleteValue: 0 };
      byGroup.set(label, entry);
    }
    entry.articleCount += 1;
    entry.totalUnits += row.finalQuantity ?? 0;
    entry.obsoleteValue += row.stockValue ?? 0;
  }

  const articles: ObsoleteArticleRow[] = obsoleteRows
    .map((row) => ({
      articleId: row.articleId,
      articleNumber: row.articleNumber,
      description: row.description,
      productGroup: row.productGroup,
      productCategory: row.productCategory,
      quantity: row.finalQuantity,
      costPrice: row.costPrice,
      stockValue: row.stockValue,
    }))
    .sort((a, b) => (b.stockValue ?? 0) - (a.stockValue ?? 0));

  return {
    totalObsoleteValue,
    percentOfTotalStockValue: percentOf(totalObsoleteValue, totalStockValue),
    obsoleteArticleCount: obsoleteRows.length,
    obsoleteTotalUnits,
    byProductCategory: Array.from(byGroup.values()).sort((a, b) => b.obsoleteValue - a.obsoleteValue),
    articles,
  };
}

// ---------------------------------------------------------------------------
// Telkwaliteit/volledigheid (spec §7)
// ---------------------------------------------------------------------------

export interface CountingQualityAnalysis {
  physicallyCountedArticles: number;
  confirmedZeroArticles: number;
  carriedOverArticles: number;
  carriedOverNotCountedArticles: number;
  /** Percentage van de SESSIESCOPE dat fysiek opgelost is (geteld of bevestigd afwezig) — 0-100. */
  percentPhysicallyResolved: number;
  /** Aantal handmatige buiten-scope-toevoegingen ("+ Bestaand artikel opzoeken") — reconstrueerbaar uit `review.results`. */
  newArticlesFound: number;
}

export function buildCountingQuality(
  kpis: Pick<
    SessionAnalysisKpis,
    "physicallyCountedArticles" | "confirmedZeroArticles" | "carriedOverArticles" | "carriedOverNotCountedArticles"
  >,
  review: SessionReviewSummary,
): CountingQualityAnalysis {
  return {
    physicallyCountedArticles: kpis.physicallyCountedArticles,
    confirmedZeroArticles: kpis.confirmedZeroArticles,
    carriedOverArticles: kpis.carriedOverArticles,
    carriedOverNotCountedArticles: kpis.carriedOverNotCountedArticles,
    percentPhysicallyResolved: percentOf(review.countedArticles, review.totalArticlesInScope),
    newArticlesFound: review.results.filter((r) => r.isManualAddition).length,
  };
}

// ---------------------------------------------------------------------------
// Grootste afwijkingen (spec §8)
// ---------------------------------------------------------------------------

export interface DeviationRow {
  articleId: string;
  articleNumber: string;
  description: string;
  previousCount: number | null;
  finalQuantity: number | null;
  differenceQuantity: number | null;
  correctionAmount: number;
}

export interface DeviationAnalysis {
  /** Sortering: grootste negatieve financiële impact eerst (meest negatief). */
  biggestNegative: DeviationRow[];
  /** Sortering: grootste positieve financiële impact eerst. */
  biggestPositive: DeviationRow[];
  /** Alle artikelen met een verschil, gesorteerd op absolute financiële impact (spec: "alle artikelen met verschillen inspecteren"). */
  all: DeviationRow[];
}

/** `limit`: hoeveel rijen elk van `biggestNegative`/`biggestPositive` toont (standaard 10) — `all` blijft altijd volledig. */
export function buildDeviationAnalysis(rows: AnalysisArticleRow[], limit = 10): DeviationAnalysis {
  const withDeviation: DeviationRow[] = rows
    .filter((row) => row.correctionAmount !== null && row.correctionAmount !== 0)
    .map((row) => ({
      articleId: row.articleId,
      articleNumber: row.articleNumber,
      description: row.description,
      previousCount: row.previousCount,
      finalQuantity: row.finalQuantity,
      differenceQuantity: row.differenceQuantity,
      correctionAmount: row.correctionAmount as number,
    }));

  const negative = withDeviation
    .filter((row) => row.correctionAmount < 0)
    .sort((a, b) => a.correctionAmount - b.correctionAmount);
  const positive = withDeviation
    .filter((row) => row.correctionAmount > 0)
    .sort((a, b) => b.correctionAmount - a.correctionAmount);
  const all = [...withDeviation].sort(
    (a, b) => Math.abs(b.correctionAmount) - Math.abs(a.correctionAmount),
  );

  return {
    biggestNegative: negative.slice(0, limit),
    biggestPositive: positive.slice(0, limit),
    all,
  };
}

// ---------------------------------------------------------------------------
// Analyse per locatie (spec §9)
// ---------------------------------------------------------------------------

export interface LocationAnalysisRow {
  locationId: string;
  locationNumber: number;
  locationName: string;
  physicallyCountedArticles: number;
  articlesWithDifference: number;
  totalUnitsCounted: number;
}

/**
 * Spec §9: "geen enkele artikel-totale voorraadwaarde aan meerdere locaties
 * toekennen (geen dubbeltelling)". Een `previousCount`/correctiewaarde is
 * enkel op ARTIKEL-niveau bevroren, nooit per locatie — er bestaat dus geen
 * betrouwbare manier om een correctie-€-bedrag aan één locatie toe te
 * kennen zonder ofwel te dubbeltellen (bij een artikel op meerdere
 * locaties) ofwel een fictieve locatie-previousCount te verzinnen. Vandaar
 * BEWUST geen €-velden hier — enkel wat wél rechtstreeks uit de bevroren
 * `perLocation`-hoeveelheden per locatie afleidbaar is: hoeveel artikelen
 * hier fysiek geteld werden, hoeveel daarvan (op artikelniveau) een verschil
 * hadden, en hoeveel stuks hier effectief geteld zijn. Een artikel dat op
 * meerdere locaties ligt, telt dus terecht op elke locatie waar het geteld
 * werd mee in "aantal met verschil" — dat is een gevolg van "dit artikel ligt
 * op meerdere plekken", geen dubbeltelling van GELD.
 */
export function buildLocationAnalysis(
  rows: ArticleSnapshot[],
  locations: Location[],
): LocationAnalysisRow[] {
  return locations
    .map((location) => {
      let physicallyCountedArticles = 0;
      let articlesWithDifference = 0;
      let totalUnitsCounted = 0;
      for (const snapshotRow of rows) {
        if (snapshotRow.status !== "GETELD" && snapshotRow.status !== "0 BEVESTIGD") continue;
        const perLocation = snapshotRow.perLocation.find((l) => l.locationId === location.id);
        if (!perLocation || !perLocation.counted) continue;
        physicallyCountedArticles += 1;
        totalUnitsCounted += perLocation.quantity ?? 0;
        if (snapshotRow.differenceQuantity !== null && snapshotRow.differenceQuantity !== 0) {
          articlesWithDifference += 1;
        }
      }
      return {
        locationId: location.id,
        locationNumber: location.number,
        locationName: location.name,
        physicallyCountedArticles,
        articlesWithDifference,
        totalUnitsCounted,
      };
    })
    .sort((a, b) => a.locationNumber - b.locationNumber);
}

// ---------------------------------------------------------------------------
// Aandachtspunten (spec §10) — regelgebaseerd, geen AI
// ---------------------------------------------------------------------------

export type AttentionPointKind =
  | "NOT_COUNTED"
  | "BIG_DEVIATION"
  | "NEW_ARTICLES"
  | "OBSOLETE_VALUE"
  | "UNKNOWN_VALUE";

export interface AttentionPoint {
  kind: AttentionPointKind;
  label: string;
}

/** Drempel voor "afwijking met grote impact" — spec geeft dit zelf als voorbeeld (€500), geen aparte instelling deze sprint. */
export const BIG_DEVIATION_THRESHOLD_EUR = 500;

function formatEuroPlain(value: number): string {
  return value.toLocaleString("nl-BE", { style: "currency", currency: "EUR" });
}

/**
 * Bewust ALLEEN items die effectief uit de bevroren data afgeleid kunnen
 * worden (spec §10: "toon enkel items die effectief door data ondersteund
 * worden"). "Onverwachte locaties gevonden" (spec-voorbeeld) staat hier
 * BEWUST niet bij: er bestaat geen bevroren vlag die onderscheidt of een
 * `CountEntry` op een op dat moment nog onverwachte locatie gebeurde (zie
 * het Sprint 2-rapport, punt 7) — dat zou hier een verzonnen/onbetrouwbaar
 * getal zijn, wat spec §7/§10 expliciet verbiedt.
 */
export function buildAttentionPoints(
  kpis: SessionAnalysisKpis,
  countingQuality: CountingQualityAnalysis,
  obsolete: ObsoleteAnalysis,
  deviations: DeviationAnalysis,
): AttentionPoint[] {
  const points: AttentionPoint[] = [];

  if (kpis.carriedOverNotCountedArticles > 0) {
    const n = kpis.carriedOverNotCountedArticles;
    points.push({
      kind: "NOT_COUNTED",
      label: `${n} artikel${n === 1 ? "" : "en"} niet fysiek geteld`,
    });
  }

  const bigDeviations = deviations.all.filter(
    (d) => Math.abs(d.correctionAmount) > BIG_DEVIATION_THRESHOLD_EUR,
  );
  if (bigDeviations.length > 0) {
    points.push({
      kind: "BIG_DEVIATION",
      label: `${bigDeviations.length} afwijking${bigDeviations.length === 1 ? "" : "en"} met impact groter dan ${formatEuroPlain(BIG_DEVIATION_THRESHOLD_EUR)}`,
    });
  }

  if (countingQuality.newArticlesFound > 0) {
    const n = countingQuality.newArticlesFound;
    points.push({ kind: "NEW_ARTICLES", label: `${n} nieuw${n === 1 ? " artikel" : "e artikelen"} gevonden` });
  }

  if (obsolete.totalObsoleteValue > 0) {
    points.push({
      kind: "OBSOLETE_VALUE",
      label: `${formatEuroPlain(obsolete.totalObsoleteValue)} obsolete voorraad`,
    });
  }

  if (kpis.articlesWithUnknownValue > 0) {
    const n = kpis.articlesWithUnknownValue;
    points.push({
      kind: "UNKNOWN_VALUE",
      label: `${n} artikel${n === 1 ? "" : "en"} zonder gekende voorraadwaarde (kostprijs of hoeveelheid onbekend)`,
    });
  }

  return points;
}

// ---------------------------------------------------------------------------
// Filters voor de detail-artikellijst (spec §11)
// ---------------------------------------------------------------------------

export type AnalysisCountingStateFilter = "ALL" | "PHYSICALLY_COUNTED" | "CARRIED_OVER";

export interface AnalysisArticleFilters {
  search: string;
  /** Filtert op de HUIDIGE canonieke Productgamma-weergavenaam (spec §11, sinds Sprint 3.2: nooit meer de bevroren bronproductgroep). */
  productCategory: string | null;
  classification: StockClassification | null;
  onlyWithDifference: boolean;
  countingState: AnalysisCountingStateFilter;
}

export const DEFAULT_ANALYSIS_ARTICLE_FILTERS: AnalysisArticleFilters = {
  search: "",
  productCategory: null,
  classification: null,
  onlyWithDifference: false,
  countingState: "ALL",
};

export function filterAnalysisArticles(
  rows: AnalysisArticleRow[],
  filters: AnalysisArticleFilters,
): AnalysisArticleRow[] {
  const term = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.productCategory !== null && row.productCategory !== filters.productCategory) return false;
    if (filters.classification !== null && row.classification !== filters.classification) return false;
    if (filters.onlyWithDifference && (row.differenceQuantity === null || row.differenceQuantity === 0)) {
      return false;
    }
    if (filters.countingState === "PHYSICALLY_COUNTED" && !row.physicallyCounted) return false;
    if (
      filters.countingState === "CARRIED_OVER" &&
      row.status !== "OVERGENOMEN" &&
      row.status !== "OVERGENOMEN - NIET GETELD"
    ) {
      return false;
    }
    if (term) {
      const haystack = `${row.articleNumber} ${row.description}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

export type AnalysisArticleSortMode =
  | "GROUP_THEN_DESCRIPTION"
  | "STOCK_VALUE_DESC"
  | "CORRECTION_AMOUNT_DESC";

export const ANALYSIS_ARTICLE_SORT_MODE_LABELS: Record<AnalysisArticleSortMode, string> = {
  GROUP_THEN_DESCRIPTION: "Productgamma → Omschrijving",
  STOCK_VALUE_DESC: "Voorraadwaarde (hoog → laag)",
  CORRECTION_AMOUNT_DESC: "Correctie € (hoog → laag)",
};

export function sortAnalysisArticles(
  rows: AnalysisArticleRow[],
  mode: AnalysisArticleSortMode,
): AnalysisArticleRow[] {
  const sorted = [...rows];
  switch (mode) {
    case "GROUP_THEN_DESCRIPTION":
      return sorted.sort((a, b) => {
        const groupCompare = a.productCategory.localeCompare(b.productCategory, "nl");
        if (groupCompare !== 0) return groupCompare;
        return a.description.localeCompare(b.description, "nl");
      });
    case "STOCK_VALUE_DESC":
      return sorted.sort((a, b) => (b.stockValue ?? -Infinity) - (a.stockValue ?? -Infinity));
    case "CORRECTION_AMOUNT_DESC":
      return sorted.sort(
        (a, b) => Math.abs(b.correctionAmount ?? 0) - Math.abs(a.correctionAmount ?? 0),
      );
  }
}

// ---------------------------------------------------------------------------
// Top-level aggregaat
// ---------------------------------------------------------------------------

export interface SessionAnalysisHeader {
  sessionId: string;
  sessionName: string;
  sessionType: CountSessionType;
  snapshotDate: string;
}

export interface SessionAnalysis {
  header: SessionAnalysisHeader;
  kpis: SessionAnalysisKpis;
  /** Sinds Sprint 3.2 §11: gegroepeerd op de HUIDIGE canonieke Productgamma, retroactief — niet meer op de bevroren bronproductgroep. */
  productCategories: ProductCategoryAnalysisRow[];
  obsolete: ObsoleteAnalysis;
  countingQuality: CountingQualityAnalysis;
  deviations: DeviationAnalysis;
  locations: LocationAnalysisRow[];
  attentionPoints: AttentionPoint[];
  articles: AnalysisArticleRow[];
}

/**
 * Bouwt de volledige "Analyse telling"-view uit een reeds bevroren
 * `StockSnapshot` + `SessionReviewSummary` (spec §13: "historische analyse
 * mag nooit stilzwijgend van levende Article-velden afhangen" — dit
 * bestand krijgt daarom uitsluitend bevroren data mee, nooit een live
 * `Article[]`-array). `locations` is de huidige `office.locations`-lijst,
 * enkel gebruikt om namen/volgorde te tonen (locatie-ID's zijn stabiel, zie
 * `domain/locations.ts`) — een intussen hernoemde locatie toont hier dus
 * terecht haar HUIDIGE naam, niet de naam op het moment van tellen (er is
 * geen apart "bevroren locatienaam"-concept in dit datamodel, en dat is
 * spec-conform: enkel artikelvelden moeten historisch bevroren zijn).
 */
export function buildSessionAnalysis(
  snapshot: StockSnapshot,
  review: SessionReviewSummary,
  locations: Location[],
  categoryResolution: Map<string, ArticleCategoryResolution>,
): SessionAnalysis {
  const articles = snapshot.articles.map((row) => toAnalysisArticleRow(row, categoryResolution));
  const kpis = computeKpis(articles, review);
  const productCategories = buildProductCategoryAnalysis(articles, kpis.totalStockValue);
  const obsolete = buildObsoleteAnalysis(articles, kpis.totalStockValue);
  const countingQuality = buildCountingQuality(kpis, review);
  const deviations = buildDeviationAnalysis(articles);
  const locationAnalysis = buildLocationAnalysis(snapshot.articles, locations);
  const attentionPoints = buildAttentionPoints(kpis, countingQuality, obsolete, deviations);

  return {
    header: {
      sessionId: snapshot.sessionId,
      sessionName: snapshot.sessionName,
      sessionType: snapshot.sessionType,
      snapshotDate: snapshot.snapshotDate,
    },
    kpis,
    productCategories,
    obsolete,
    countingQuality,
    deviations,
    locations: locationAnalysis,
    attentionPoints,
    articles,
  };
}
