import { toAnalysisArticleRow } from "./analysis";
import type { AnalysisArticleRow } from "./analysis";
import type { ArticleSnapshotStatus, StockSnapshot } from "./stockSnapshot";
import type { CountSessionType, StockClassification } from "./types";

/**
 * Sprint 3 — Vergelijking tussen stocktellingen. PURE domeinlogica voor het
 * vergelijken van twee AFGERONDE, bevroren `StockSnapshot`s (telling A en
 * telling B) van hetzelfde kantoor — en, voor de opeenvolgende-tellingen-
 * berekening (§8-9), een langere reeks eerdere bevroren snapshots.
 *
 * KERNREGEL (spec, herhaald): dit bestand leest NOOIT live `Article`-data —
 * exact dezelfde garantie als `domain/analysis.ts` (zie de uitleg daar).
 * Elke `StockSnapshot` die hier binnenkomt is al bevroren op het moment dat
 * de betreffende sessie werd afgerond. Geen React, geen Excel, geen
 * IndexedDB, en bewust geen import van `application/` (domain/ mag nooit van
 * application/ afhangen, zie docs/ARCHITECTURE.md).
 *
 * KERNREGEL 2 ("nooit blind sommeren over eenheden heen", spec §4): dit
 * bestand somt NERGENS ruwe hoeveelheden (`quantity`) op over het volledige
 * kantoor heen — enkel €-waarden (die zijn eenheid-onafhankelijk, want al
 * `hoeveelheid × kostprijs`) en aantallen ARTIKELEN worden opgeteld. Een
 * hoeveelheid wordt uitsluitend per artikel vergeleken (A t.o.v. B van
 * HETZELFDE artikel, dus per definitie dezelfde eenheid).
 *
 * KERNREGEL 3 ("ontbrekend ≠ 0", spec §8/§11): `StockSnapshot.articles` bevat
 * altijd ALLE artikelen van het kantoor op het moment van afronden (zie
 * `stockSnapshot.ts#buildSessionSnapshot`) — een artikel dat in een snapshot
 * ontbreekt, bestond op dat moment dus simpelweg nog niet in de artikelstam.
 * Dat is fundamenteel iets anders dan een gekende hoeveelheid van 0, en wordt
 * overal hieronder ook zo behandeld (nooit `?? 0` op een hoeveelheid).
 */

// ---------------------------------------------------------------------------
// Invoer
// ---------------------------------------------------------------------------

export interface ComparisonSnapshotInput {
  sessionId: string;
  sessionName: string;
  sessionType: CountSessionType;
  snapshotDate: string;
  completedAt: string | null;
  snapshot: StockSnapshot;
}

/** Minimale, per-artikel gegevens die de opeenvolgende-tellingen-berekening nodig heeft uit één historische snapshot. */
export interface HistoricalArticleQuantity {
  totalCount: number | null;
  status: ArticleSnapshotStatus;
}

/**
 * Eén ingang van de betrouwbare kantoorhistoriek voor de opeenvolgende-
 * tellingen-berekening (spec §8), nieuwste-eerst, met de te vergelijken
 * telling B als EERSTE ingang (index 0). `articlesById` ontbreekt precies
 * wanneer deze sessie GEEN bevroren `FinalizedSessionResult` heeft (een
 * legacy/pre-hardening sessie) — dat is bewust géén "gat dat overgeslagen
 * wordt": de keten van opeenvolgende tellingen STOPT hier (spec: "mag niet
 * stilletjes meetellen als betrouwbare observatie"), zie
 * `computeConsecutiveUnchanged` hieronder.
 */
export interface ReliableHistoryEntry {
  sessionId: string;
  sessionName: string;
  articlesById?: Map<string, HistoricalArticleQuantity>;
}

/** Businessregel-constante (spec §9): "3" als benoemde, aanpasbare drempel — nooit een magisch getal in de code. */
export const CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD = 3;

const PRODUCT_GROUP_FALLBACK = "(geen productgroep)";
function groupLabel(productGroup: string | null): string {
  return productGroup ?? PRODUCT_GROUP_FALLBACK;
}

function percentOf(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

/** `null` wanneer de basiswaarde (A) 0 is — een percentage t.o.v. nul is niet zinvol te berekenen, dus nooit fictief 0% of Infinity tonen. */
function percentChange(from: number, to: number): number | null {
  if (from === 0) return null;
  return ((to - from) / from) * 100;
}

// ---------------------------------------------------------------------------
// Opeenvolgende tellingen ongewijzigd (spec §8-9)
// ---------------------------------------------------------------------------

export interface ConsecutiveUnchangedResult {
  /** Aantal opeenvolgende, betrouwbare snapshots (incl. B) met exact dezelfde hoeveelheid. */
  count: number;
  /** Hoeveel van die `count` snapshots fysiek GETELD of 0 BEVESTIGD waren (spec §9: "indien betrouwbaar beschikbaar"). */
  physicallyCountedCount: number;
  /** Naam van de OUDSTE telling in deze ongewijzigde reeks — "sinds welke telling" (spec §8/§9). */
  sinceSessionName: string | null;
  /** Naam van de telling waar de hoeveelheid voor het laatst ANDERS was, indien binnen de betrouwbare historiek gekend. */
  lastQuantityChangeSessionName: string | null;
  /** True wanneer de volledige meegegeven historiek doorlopen werd zonder een verschil/gat/legacy-sessie tegen te komen. */
  reachedStartOfHistory: boolean;
}

/**
 * Loopt van B (index 0) terug door de betrouwbare historiek en telt hoeveel
 * opeenvolgende snapshots exact dezelfde hoeveelheid tonen. Stopt hard
 * (nooit stilzwijgend overslaan) zodra:
 *   - een snapshot een ANDERE hoeveelheid toont (reeks eindigt hier — deze
 *     sessie is dan "wanneer het laatst veranderde");
 *   - het artikel in een snapshot volledig ontbreekt (bestond nog niet —
 *     spec §8: "ontbrekend is niet hetzelfde als quantity 0", dus geen
 *     verdere uitspraak mogelijk over "ervoor");
 *   - een snapshot GEEN `articlesById` heeft (legacy/onbetrouwbare sessie —
 *     spec §8: "mag niet stilletjes meetellen als betrouwbare observatie"),
 *     of de gekende hoeveelheid zelf `null` is (nog nooit een geldige
 *     fysieke telling gekend).
 */
export function computeConsecutiveUnchanged(
  articleId: string,
  historyNewestFirstFromB: ReliableHistoryEntry[],
): ConsecutiveUnchangedResult {
  let count = 0;
  let physicallyCountedCount = 0;
  let referenceQuantity: number | null = null;
  let sinceSessionName: string | null = null;
  let lastQuantityChangeSessionName: string | null = null;

  for (const entry of historyNewestFirstFromB) {
    if (!entry.articlesById) {
      return { count, physicallyCountedCount, sinceSessionName, lastQuantityChangeSessionName, reachedStartOfHistory: false };
    }
    const row = entry.articlesById.get(articleId);
    if (!row || row.totalCount === null) {
      return { count, physicallyCountedCount, sinceSessionName, lastQuantityChangeSessionName, reachedStartOfHistory: false };
    }
    if (referenceQuantity !== null && row.totalCount !== referenceQuantity) {
      lastQuantityChangeSessionName = entry.sessionName;
      return { count, physicallyCountedCount, sinceSessionName, lastQuantityChangeSessionName, reachedStartOfHistory: false };
    }
    referenceQuantity = row.totalCount;
    count += 1;
    sinceSessionName = entry.sessionName;
    if (row.status === "GETELD" || row.status === "0 BEVESTIGD") physicallyCountedCount += 1;
  }
  return {
    count,
    physicallyCountedCount,
    sinceSessionName,
    lastQuantityChangeSessionName,
    reachedStartOfHistory: count > 0,
  };
}

// ---------------------------------------------------------------------------
// Per-artikel vergelijkingsrij (basis voor movers/unchanged/kandidaten/detail)
// ---------------------------------------------------------------------------

export interface ArticleComparisonRow {
  articleId: string;
  articleNumber: string;
  description: string;
  productGroup: string | null;
  unit: string | null;
  presentInA: boolean;
  presentInB: boolean;
  classificationA: StockClassification | null;
  classificationB: StockClassification | null;
  quantityA: number | null;
  quantityB: number | null;
  /** B - A, enkel gekend wanneer het artikel in BEIDE snapshots een gekende hoeveelheid had. */
  quantityDifference: number | null;
  costPriceA: number | null;
  costPriceB: number | null;
  stockValueA: number | null;
  stockValueB: number | null;
  /** B - A, enkel gekend wanneer beide zijden een gekende voorraadwaarde hadden. */
  valueDifference: number | null;
  /**
   * Sprint 3.1 §1: kostprijs B - kostprijs A, enkel gekend wanneer het
   * artikel in BEIDE snapshots voorkomt MET een gekende kostprijs aan beide
   * kanten. Nooit met 0 invullen wanneer een kostprijs onbekend is (spec §2).
   */
  priceDifferencePerUnit: number | null;
  /** Percentagevariant van `priceDifferencePerUnit` — `null` wanneer kostprijs A 0 is of een van beide onbekend is. */
  pricePercentChange: number | null;
  /**
   * Sprint 3.1 §2: ontbinding van `valueDifference` in een hoeveelheids- en
   * een prijscomponent — `(quantityB - quantityA) × costPriceA`. Beide enkel
   * gekend wanneer hoeveelheid ÉN kostprijs aan beide kanten gekend zijn;
   * samen tellen ze exact op tot `valueDifference` (spec §2).
   */
  quantityEffect: number | null;
  /** Sprint 3.1 §2: `quantityB × (costPriceB - costPriceA)`. */
  priceEffect: number | null;
  /** true enkel wanneer het artikel in BEIDE snapshots voorkomt met exact dezelfde gekende hoeveelheid (spec §7). */
  quantityUnchanged: boolean;
  /** true enkel wanneer het artikel in BEIDE snapshots voorkomt met een gekende, VERSCHILLENDE hoeveelheid. */
  quantityChanged: boolean;
  /** Ontbreekt volledig in A, bestaat in B (spec §11). */
  isNewArticle: boolean;
  /** Bestaat in A, ontbreekt volledig in B — NIET automatisch als "voorraad 0" te lezen (spec §11). */
  isDisappeared: boolean;
  /** Bestaat in beide, A = 0 en B > 0 (spec §11). */
  isFromZero: boolean;
  /** Bestaat in beide, A > 0 en B = 0 (spec §11). */
  isToZero: boolean;
  /** ACTIVE in A → OBSOLETE in B (spec §10), enkel wanneer het artikel in beide snapshots gekend was. */
  isNewObsolete: boolean;
  /** OBSOLETE in A → OBSOLETE in B. */
  isStayedObsolete: boolean;
  /** OBSOLETE in A → ACTIVE in B. */
  isReactivated: boolean;
  consecutiveUnchangedCount: number;
  consecutiveUnchangedSinceSessionName: string | null;
  consecutiveUnchangedPhysicallyCountedCount: number;
  lastQuantityChangeSessionName: string | null;
  /**
   * Kandidaat voor obsolete-review (spec §9) — GEEN nieuwe status, nooit
   * automatisch gezet: classificatie in B = ACTIVE, quantity B > 0, en
   * minstens `CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD`
   * opeenvolgende betrouwbare tellingen ongewijzigd.
   */
  isObsoleteCandidate: boolean;
}

function buildArticleComparisonRows(
  rowsAById: Map<string, AnalysisArticleRow>,
  rowsBById: Map<string, AnalysisArticleRow>,
  consecutiveFor: (articleId: string) => ConsecutiveUnchangedResult,
): ArticleComparisonRow[] {
  const ids = new Set<string>([...rowsAById.keys(), ...rowsBById.keys()]);
  const rows: ArticleComparisonRow[] = [];

  for (const articleId of ids) {
    const a = rowsAById.get(articleId);
    const b = rowsBById.get(articleId);
    const presentInA = a !== undefined;
    const presentInB = b !== undefined;
    // Voor omschrijving/productgroep/eenheid: geef voorkeur aan de meest
    // recente (B) kant zodra bekend — puur weergave, geen berekening.
    const display = b ?? a!;

    const quantityA = a?.finalQuantity ?? null;
    const quantityB = b?.finalQuantity ?? null;
    const stockValueA = a?.stockValue ?? null;
    const stockValueB = b?.stockValue ?? null;
    const costPriceA = a?.costPrice ?? null;
    const costPriceB = b?.costPrice ?? null;

    const bothKnownQuantity = presentInA && presentInB && quantityA !== null && quantityB !== null;
    const quantityDifference = bothKnownQuantity ? (quantityB as number) - (quantityA as number) : null;
    const bothKnownValue = presentInA && presentInB && stockValueA !== null && stockValueB !== null;
    const valueDifference = bothKnownValue ? (stockValueB as number) - (stockValueA as number) : null;
    const quantityUnchanged = bothKnownQuantity && quantityA === quantityB;
    const quantityChanged = bothKnownQuantity && quantityA !== quantityB;

    // Sprint 3.1 §1-2: prijsverschil + hoeveelheids-/prijseffect-ontbinding.
    // Bewust apart van `bothKnownValue` hierboven: een voorraadwaarde kan om
    // een andere reden onbekend zijn, en omgekeerd — enkel wanneer zowel de
    // hoeveelheid als de kostprijs aan BEIDE kanten gekend zijn, mag hier iets
    // afgeleid worden (spec §2: "nooit met 0 invullen").
    const bothKnownCostPrice = presentInA && presentInB && costPriceA !== null && costPriceB !== null;
    const priceDifferencePerUnit = bothKnownCostPrice ? (costPriceB as number) - (costPriceA as number) : null;
    const pricePercentChange = bothKnownCostPrice
      ? percentChange(costPriceA as number, costPriceB as number)
      : null;
    const canDecomposeValueChange = bothKnownQuantity && bothKnownCostPrice;
    const quantityEffect = canDecomposeValueChange
      ? ((quantityB as number) - (quantityA as number)) * (costPriceA as number)
      : null;
    const priceEffect = canDecomposeValueChange
      ? (quantityB as number) * ((costPriceB as number) - (costPriceA as number))
      : null;

    const isNewArticle = !presentInA && presentInB;
    const isDisappeared = presentInA && !presentInB;
    const isFromZero = presentInA && presentInB && quantityA === 0 && quantityB !== null && quantityB > 0;
    const isToZero = presentInA && presentInB && quantityA !== null && quantityA > 0 && quantityB === 0;

    const classificationA = a?.classification ?? null;
    const classificationB = b?.classification ?? null;
    const bothKnownClassification = presentInA && presentInB;
    const isNewObsolete = bothKnownClassification && classificationA === "ACTIVE" && classificationB === "OBSOLETE";
    const isStayedObsolete = bothKnownClassification && classificationA === "OBSOLETE" && classificationB === "OBSOLETE";
    const isReactivated = bothKnownClassification && classificationA === "OBSOLETE" && classificationB === "ACTIVE";

    const consecutive = presentInB
      ? consecutiveFor(articleId)
      : {
          count: 0,
          physicallyCountedCount: 0,
          sinceSessionName: null,
          lastQuantityChangeSessionName: null,
          reachedStartOfHistory: false,
        };
    const isObsoleteCandidate =
      presentInB &&
      classificationB === "ACTIVE" &&
      quantityB !== null &&
      quantityB > 0 &&
      consecutive.count >= CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD;

    rows.push({
      articleId,
      articleNumber: display.articleNumber,
      description: display.description,
      productGroup: display.productGroup,
      unit: display.unit,
      presentInA,
      presentInB,
      classificationA,
      classificationB,
      quantityA,
      quantityB,
      quantityDifference,
      costPriceA,
      costPriceB,
      stockValueA,
      stockValueB,
      valueDifference,
      priceDifferencePerUnit,
      pricePercentChange,
      quantityEffect,
      priceEffect,
      quantityUnchanged,
      quantityChanged,
      isNewArticle,
      isDisappeared,
      isFromZero,
      isToZero,
      isNewObsolete,
      isStayedObsolete,
      isReactivated,
      consecutiveUnchangedCount: consecutive.count,
      consecutiveUnchangedSinceSessionName: consecutive.sinceSessionName,
      consecutiveUnchangedPhysicallyCountedCount: consecutive.physicallyCountedCount,
      lastQuantityChangeSessionName: consecutive.lastQuantityChangeSessionName,
      isObsoleteCandidate,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Hoofd-KPI's (spec §4)
// ---------------------------------------------------------------------------

export interface StockValueComparisonKpi {
  valueA: number;
  valueB: number;
  differenceAmount: number;
  differencePercent: number | null;
}
export interface ObsoleteComparisonKpi {
  valueA: number;
  valueB: number;
  differenceAmount: number;
  percentOfTotalA: number;
  percentOfTotalB: number;
  countA: number;
  countB: number;
}
export interface ArticleCountComparisonKpi {
  countA: number;
  countB: number;
  difference: number;
}
export interface StockQualityComparisonKpi {
  activeValueA: number;
  activeValueB: number;
  obsoleteValueA: number;
  obsoleteValueB: number;
}
export interface ComparisonKpis {
  stockValue: StockValueComparisonKpi;
  obsolete: ObsoleteComparisonKpi;
  articles: ArticleCountComparisonKpi;
  quality: StockQualityComparisonKpi;
}

function sumStockValue(rows: AnalysisArticleRow[]): number {
  return rows.reduce((sum, r) => sum + (r.stockValue ?? 0), 0);
}
function sumStockValueWhere(rows: AnalysisArticleRow[], classification: StockClassification): number {
  return rows
    .filter((r) => r.classification === classification)
    .reduce((sum, r) => sum + (r.stockValue ?? 0), 0);
}

function buildKpis(rowsA: AnalysisArticleRow[], rowsB: AnalysisArticleRow[]): ComparisonKpis {
  const valueA = sumStockValue(rowsA);
  const valueB = sumStockValue(rowsB);
  const obsoleteValueA = sumStockValueWhere(rowsA, "OBSOLETE");
  const obsoleteValueB = sumStockValueWhere(rowsB, "OBSOLETE");
  const activeValueA = sumStockValueWhere(rowsA, "ACTIVE");
  const activeValueB = sumStockValueWhere(rowsB, "ACTIVE");

  return {
    stockValue: {
      valueA,
      valueB,
      differenceAmount: valueB - valueA,
      differencePercent: percentChange(valueA, valueB),
    },
    obsolete: {
      valueA: obsoleteValueA,
      valueB: obsoleteValueB,
      differenceAmount: obsoleteValueB - obsoleteValueA,
      percentOfTotalA: percentOf(obsoleteValueA, valueA),
      percentOfTotalB: percentOf(obsoleteValueB, valueB),
      countA: rowsA.filter((r) => r.classification === "OBSOLETE").length,
      countB: rowsB.filter((r) => r.classification === "OBSOLETE").length,
    },
    // Aantal ARTIKELEN (nooit hoeveelheden/eenheden) — spec §4 kernregel.
    articles: {
      countA: rowsA.length,
      countB: rowsB.length,
      difference: rowsB.length - rowsA.length,
    },
    quality: { activeValueA, activeValueB, obsoleteValueA, obsoleteValueB },
  };
}

// ---------------------------------------------------------------------------
// Productgroepvergelijking (spec §5)
// ---------------------------------------------------------------------------

export interface ProductGroupComparisonRow {
  productGroup: string;
  valueA: number;
  valueB: number;
  valueDifference: number;
  valueDifferencePercent: number | null;
  obsoleteValueA: number;
  obsoleteValueB: number;
  articleCountA: number;
  articleCountB: number;
}

/** Standaard sortering (spec §5): grootste absolute verandering in voorraadwaarde eerst. Geen productgroepen hardcoded — puur afgeleid uit de data. */
function buildProductGroupComparison(
  rowsA: AnalysisArticleRow[],
  rowsB: AnalysisArticleRow[],
): ProductGroupComparisonRow[] {
  interface Accumulator {
    valueA: number;
    valueB: number;
    obsoleteValueA: number;
    obsoleteValueB: number;
    articleCountA: number;
    articleCountB: number;
  }
  const byGroup = new Map<string, Accumulator>();
  function ensure(label: string): Accumulator {
    let entry = byGroup.get(label);
    if (!entry) {
      entry = { valueA: 0, valueB: 0, obsoleteValueA: 0, obsoleteValueB: 0, articleCountA: 0, articleCountB: 0 };
      byGroup.set(label, entry);
    }
    return entry;
  }
  for (const row of rowsA) {
    const entry = ensure(groupLabel(row.productGroup));
    entry.valueA += row.stockValue ?? 0;
    entry.articleCountA += 1;
    if (row.classification === "OBSOLETE") entry.obsoleteValueA += row.stockValue ?? 0;
  }
  for (const row of rowsB) {
    const entry = ensure(groupLabel(row.productGroup));
    entry.valueB += row.stockValue ?? 0;
    entry.articleCountB += 1;
    if (row.classification === "OBSOLETE") entry.obsoleteValueB += row.stockValue ?? 0;
  }
  return Array.from(byGroup.entries())
    .map(([productGroup, entry]) => ({
      productGroup,
      valueA: entry.valueA,
      valueB: entry.valueB,
      valueDifference: entry.valueB - entry.valueA,
      valueDifferencePercent: percentChange(entry.valueA, entry.valueB),
      obsoleteValueA: entry.obsoleteValueA,
      obsoleteValueB: entry.obsoleteValueB,
      articleCountA: entry.articleCountA,
      articleCountB: entry.articleCountB,
    }))
    .sort((a, b) => Math.abs(b.valueDifference) - Math.abs(a.valueDifference));
}

// ---------------------------------------------------------------------------
// Grootste stijgingen/dalingen (spec §6)
// ---------------------------------------------------------------------------

/** Documenteert of een waardeverschil (mede) door de hoeveelheid, de kostprijs, of beide veroorzaakt is (spec §6: nooit automatisch als fysieke voorraadbeweging interpreteren). */
export type ValueChangeDriver = "QUANTITY" | "COST_PRICE" | "BOTH" | "UNKNOWN";

export interface MoverRow {
  articleId: string;
  articleNumber: string;
  description: string;
  productGroup: string | null;
  quantityA: number | null;
  quantityB: number | null;
  costPriceA: number | null;
  costPriceB: number | null;
  stockValueA: number | null;
  stockValueB: number | null;
  valueDifference: number;
  driver: ValueChangeDriver;
  /** Sprint 3.1 §3: zodat bij `driver === "BOTH"` zichtbaar is hoeveel van `valueDifference` door hoeveelheid resp. kostprijs komt. */
  priceDifferencePerUnit: number | null;
  pricePercentChange: number | null;
  quantityEffect: number | null;
  priceEffect: number | null;
}

function determineDriver(row: ArticleComparisonRow): ValueChangeDriver {
  const quantityChanged = row.quantityA !== null && row.quantityB !== null && row.quantityA !== row.quantityB;
  const costChanged = row.costPriceA !== null && row.costPriceB !== null && row.costPriceA !== row.costPriceB;
  if (quantityChanged && costChanged) return "BOTH";
  if (quantityChanged) return "QUANTITY";
  if (costChanged) return "COST_PRICE";
  return "UNKNOWN";
}

export interface MoversAnalysis {
  biggestIncreases: MoverRow[];
  biggestDecreases: MoverRow[];
}

function toMoverRow(row: ArticleComparisonRow): MoverRow {
  return {
    articleId: row.articleId,
    articleNumber: row.articleNumber,
    description: row.description,
    productGroup: row.productGroup,
    quantityA: row.quantityA,
    quantityB: row.quantityB,
    costPriceA: row.costPriceA,
    costPriceB: row.costPriceB,
    stockValueA: row.stockValueA,
    stockValueB: row.stockValueB,
    valueDifference: row.valueDifference as number,
    driver: determineDriver(row),
    priceDifferencePerUnit: row.priceDifferencePerUnit,
    pricePercentChange: row.pricePercentChange,
    quantityEffect: row.quantityEffect,
    priceEffect: row.priceEffect,
  };
}

/** `limit`: hoeveel rijen elke sectie toont (standaard 10, zelfde conventie als `domain/analysis.ts#buildDeviationAnalysis`). Enkel artikelen die in BEIDE snapshots gekend zijn (spec §11 behandelt nieuw/verdwenen apart). */
function buildMovers(rows: ArticleComparisonRow[], limit = 10): MoversAnalysis {
  const comparable = rows.filter((r) => r.presentInA && r.presentInB && r.valueDifference !== null && r.valueDifference !== 0);
  const increases = comparable
    .filter((r) => (r.valueDifference as number) > 0)
    .sort((a, b) => (b.valueDifference as number) - (a.valueDifference as number));
  const decreases = comparable
    .filter((r) => (r.valueDifference as number) < 0)
    .sort((a, b) => (a.valueDifference as number) - (b.valueDifference as number));
  return {
    biggestIncreases: increases.slice(0, limit).map(toMoverRow),
    biggestDecreases: decreases.slice(0, limit).map(toMoverRow),
  };
}

// ---------------------------------------------------------------------------
// Grootste prijsstijgingen/dalingen (Sprint 3.1 §6)
// ---------------------------------------------------------------------------

/**
 * Eén artikel binnen "Grootste prijsstijgingen/dalingen" — bewust een apart
 * type van `MoverRow` (die sorteert op totale €-waardeverandering, niet
 * specifiek op prijs): hier telt uitsluitend het FINANCIEEL prijseffect op de
 * huidige voorraad (`quantityB × prijsverschil`), zodat een kleine
 * prijswijziging op veel stuks relevanter weegt dan een grote wijziging op
 * één stuk (spec §6, letterlijk voorbeeld).
 */
export interface PriceMoverRow {
  articleId: string;
  articleNumber: string;
  description: string;
  productGroup: string | null;
  costPriceA: number;
  costPriceB: number;
  priceDifferencePerUnit: number;
  pricePercentChange: number | null;
  quantityB: number | null;
  /** Financieel prijseffect op de huidige stock (`quantityB × priceDifferencePerUnit`) — de sorteersleutel. */
  priceEffect: number;
}

export interface PriceMoversAnalysis {
  biggestIncreases: PriceMoverRow[];
  biggestDecreases: PriceMoverRow[];
}

function toPriceMoverRow(row: ArticleComparisonRow): PriceMoverRow {
  return {
    articleId: row.articleId,
    articleNumber: row.articleNumber,
    description: row.description,
    productGroup: row.productGroup,
    costPriceA: row.costPriceA as number,
    costPriceB: row.costPriceB as number,
    priceDifferencePerUnit: row.priceDifferencePerUnit as number,
    pricePercentChange: row.pricePercentChange,
    quantityB: row.quantityB,
    priceEffect: row.priceEffect as number,
  };
}

/**
 * `limit`: zelfde conventie als `buildMovers` (standaard 10). Enkel
 * artikelen waarvoor zowel het prijsverschil als het financieel prijseffect
 * op de huidige voorraad gekend zijn (spec §7: nooit een onbekende kostprijs
 * verzinnen) — dus zowel A als B moeten een bevroren kostprijs hebben ÉN
 * `quantityB` moet gekend zijn (anders is er geen "huidige stock" om het
 * effect op te berekenen).
 */
function buildPriceMovers(rows: ArticleComparisonRow[], limit = 10): PriceMoversAnalysis {
  const comparable = rows.filter(
    (r) => r.priceDifferencePerUnit !== null && r.priceDifferencePerUnit !== 0 && r.priceEffect !== null,
  );
  const increases = comparable
    .filter((r) => (r.priceDifferencePerUnit as number) > 0)
    .sort((a, b) => (b.priceEffect as number) - (a.priceEffect as number));
  const decreases = comparable
    .filter((r) => (r.priceDifferencePerUnit as number) < 0)
    .sort((a, b) => (a.priceEffect as number) - (b.priceEffect as number));
  return {
    biggestIncreases: increases.slice(0, limit).map(toPriceMoverRow),
    biggestDecreases: decreases.slice(0, limit).map(toPriceMoverRow),
  };
}

// ---------------------------------------------------------------------------
// Ongewijzigde voorraad (spec §7)
// ---------------------------------------------------------------------------

export interface UnchangedStockAnalysis {
  articleCount: number;
  totalStockValueB: number;
  percentOfTotalStockValueB: number;
  /** Default sort (spec §7): hoogste voorraadwaarde B eerst. */
  rows: ArticleComparisonRow[];
}

function buildUnchangedStockAnalysis(rows: ArticleComparisonRow[], totalStockValueB: number): UnchangedStockAnalysis {
  const unchanged = rows.filter((r) => r.quantityUnchanged);
  const totalValue = unchanged.reduce((sum, r) => sum + (r.stockValueB ?? 0), 0);
  return {
    articleCount: unchanged.length,
    totalStockValueB: totalValue,
    percentOfTotalStockValueB: percentOf(totalValue, totalStockValueB),
    rows: [...unchanged].sort((a, b) => (b.stockValueB ?? 0) - (a.stockValueB ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Kandidaten voor obsolete-review (spec §9)
// ---------------------------------------------------------------------------

function buildObsoleteCandidates(rows: ArticleComparisonRow[]): ArticleComparisonRow[] {
  return rows
    .filter((r) => r.isObsoleteCandidate)
    .sort(
      (a, b) =>
        b.consecutiveUnchangedCount - a.consecutiveUnchangedCount || (b.stockValueB ?? 0) - (a.stockValueB ?? 0),
    );
}

// ---------------------------------------------------------------------------
// Obsolete vergelijking (spec §10)
// ---------------------------------------------------------------------------

export interface ObsoleteTransitionLists {
  newObsolete: ArticleComparisonRow[];
  stayedObsolete: ArticleComparisonRow[];
  reactivated: ArticleComparisonRow[];
}

function buildObsoleteTransitions(rows: ArticleComparisonRow[]): ObsoleteTransitionLists {
  const byValueDesc = (a: ArticleComparisonRow, b: ArticleComparisonRow) => (b.stockValueB ?? 0) - (a.stockValueB ?? 0);
  return {
    newObsolete: rows.filter((r) => r.isNewObsolete).sort(byValueDesc),
    stayedObsolete: rows.filter((r) => r.isStayedObsolete).sort(byValueDesc),
    reactivated: rows.filter((r) => r.isReactivated).sort(byValueDesc),
  };
}

// ---------------------------------------------------------------------------
// Nieuwe / naar nul / verdwenen artikelen (spec §11) — telling, de rijen zelf
// zijn al beschikbaar via de flags op ArticleComparisonRow.
// ---------------------------------------------------------------------------

export interface ArticleTransitionCounts {
  newArticles: number;
  toZero: number;
  fromZero: number;
  disappeared: number;
}

function countTransitions(rows: ArticleComparisonRow[]): ArticleTransitionCounts {
  return {
    newArticles: rows.filter((r) => r.isNewArticle).length,
    toZero: rows.filter((r) => r.isToZero).length,
    fromZero: rows.filter((r) => r.isFromZero).length,
    disappeared: rows.filter((r) => r.isDisappeared).length,
  };
}

// ---------------------------------------------------------------------------
// Aandachtspunten (spec §13) — regelgebaseerd, geen AI
// ---------------------------------------------------------------------------

export type ComparisonAttentionPointKind =
  | "STOCK_VALUE_CHANGE"
  | "OBSOLETE_VALUE_CHANGE"
  | "CONSECUTIVE_UNCHANGED"
  | "OBSOLETE_CANDIDATE_VALUE"
  | "TO_ZERO"
  | "NEW_OBSOLETE";

export interface ComparisonAttentionPoint {
  kind: ComparisonAttentionPointKind;
  label: string;
}

function formatEuroPlain(value: number): string {
  return value.toLocaleString("nl-BE", { style: "currency", currency: "EUR" });
}
function formatSignedEuroPlain(value: number): string {
  const formatted = Math.abs(value).toLocaleString("nl-BE", { style: "currency", currency: "EUR" });
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}
function formatSignedPercent(value: number): string {
  const formatted = Math.abs(value).toFixed(1);
  if (value > 0) return `+${formatted}%`;
  if (value < 0) return `-${formatted}%`;
  return `${formatted}%`;
}

/** Enkel items die effectief uit de bevroren vergelijking afgeleid kunnen worden (zelfde principe als `domain/analysis.ts#buildAttentionPoints`). */
function buildAttentionPoints(
  kpis: ComparisonKpis,
  allRows: ArticleComparisonRow[],
  obsoleteCandidates: ArticleComparisonRow[],
  transitions: ArticleTransitionCounts,
  obsoleteTransitions: ObsoleteTransitionLists,
): ComparisonAttentionPoint[] {
  const points: ComparisonAttentionPoint[] = [];

  if (kpis.stockValue.differenceAmount !== 0) {
    const pct = kpis.stockValue.differencePercent;
    points.push({
      kind: "STOCK_VALUE_CHANGE",
      label: `Totale voorraadwaarde ${formatSignedEuroPlain(kpis.stockValue.differenceAmount)}${
        pct !== null ? ` (${formatSignedPercent(pct)})` : ""
      }`,
    });
  }

  if (kpis.obsolete.differenceAmount !== 0) {
    points.push({
      kind: "OBSOLETE_VALUE_CHANGE",
      label: `Obsolete voorraad ${formatSignedEuroPlain(kpis.obsolete.differenceAmount)}`,
    });
  }

  const longUnchanged = allRows.filter(
    (r) => r.presentInB && r.consecutiveUnchangedCount >= CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD,
  ).length;
  if (longUnchanged > 0) {
    points.push({
      kind: "CONSECUTIVE_UNCHANGED",
      label: `${longUnchanged} artikel${longUnchanged === 1 ? "" : "en"} al ≥${CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD} tellingen ongewijzigd`,
    });
  }

  if (obsoleteCandidates.length > 0) {
    const value = obsoleteCandidates.reduce((sum, r) => sum + (r.stockValueB ?? 0), 0);
    points.push({
      kind: "OBSOLETE_CANDIDATE_VALUE",
      label: `${formatEuroPlain(value)} actieve voorraad kandidaat voor obsolete-review`,
    });
  }

  if (transitions.toZero > 0) {
    points.push({
      kind: "TO_ZERO",
      label: `${transitions.toZero} artikel${transitions.toZero === 1 ? "" : "en"} naar voorraad 0`,
    });
  }

  if (obsoleteTransitions.newObsolete.length > 0) {
    const n = obsoleteTransitions.newObsolete.length;
    points.push({ kind: "NEW_OBSOLETE", label: `${n} artikel${n === 1 ? "" : "en"} nieuw obsolete geworden` });
  }

  return points;
}

// ---------------------------------------------------------------------------
// Filters/sortering voor de volledige detailtabel (spec §12)
// ---------------------------------------------------------------------------

export type ComparisonStateFilter =
  | "ALL"
  | "CHANGED"
  | "UNCHANGED"
  | "OBSOLETE_CANDIDATE"
  | "NEW_ARTICLE"
  | "TO_ZERO"
  | "NEW_OBSOLETE";

export interface ArticleComparisonFilters {
  search: string;
  productGroup: string | null;
  /** Filtert op classificatie in B (de "huidige" telling) — zelfde conventie als spec §9's "huidige classificatie". */
  classification: StockClassification | null;
  state: ComparisonStateFilter;
}

export const DEFAULT_ARTICLE_COMPARISON_FILTERS: ArticleComparisonFilters = {
  search: "",
  productGroup: null,
  classification: null,
  state: "ALL",
};

export function filterArticleComparisonRows(
  rows: ArticleComparisonRow[],
  filters: ArticleComparisonFilters,
): ArticleComparisonRow[] {
  const term = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.productGroup !== null && groupLabel(row.productGroup) !== filters.productGroup) return false;
    if (filters.classification !== null && row.classificationB !== filters.classification) return false;
    switch (filters.state) {
      case "CHANGED":
        if (!row.quantityChanged) return false;
        break;
      case "UNCHANGED":
        if (!row.quantityUnchanged) return false;
        break;
      case "OBSOLETE_CANDIDATE":
        if (!row.isObsoleteCandidate) return false;
        break;
      case "NEW_ARTICLE":
        if (!row.isNewArticle) return false;
        break;
      case "TO_ZERO":
        if (!row.isToZero) return false;
        break;
      case "NEW_OBSOLETE":
        if (!row.isNewObsolete) return false;
        break;
    }
    if (term) {
      const haystack = `${row.articleNumber} ${row.description}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

export type ArticleComparisonSortMode = "VALUE_DIFF_DESC" | "STOCK_VALUE_B_DESC" | "PRODUCT_GROUP" | "DESCRIPTION";

export const ARTICLE_COMPARISON_SORT_MODE_LABELS: Record<ArticleComparisonSortMode, string> = {
  VALUE_DIFF_DESC: "Grootste waardeverschil",
  STOCK_VALUE_B_DESC: "Hoogste huidige voorraadwaarde",
  PRODUCT_GROUP: "Productgroep",
  DESCRIPTION: "Omschrijving",
};

export function sortArticleComparisonRows(
  rows: ArticleComparisonRow[],
  mode: ArticleComparisonSortMode,
): ArticleComparisonRow[] {
  const sorted = [...rows];
  switch (mode) {
    case "VALUE_DIFF_DESC":
      return sorted.sort((a, b) => Math.abs(b.valueDifference ?? 0) - Math.abs(a.valueDifference ?? 0));
    case "STOCK_VALUE_B_DESC":
      return sorted.sort((a, b) => (b.stockValueB ?? -Infinity) - (a.stockValueB ?? -Infinity));
    case "PRODUCT_GROUP":
      return sorted.sort((a, b) => {
        const groupCompare = groupLabel(a.productGroup).localeCompare(groupLabel(b.productGroup), "nl");
        if (groupCompare !== 0) return groupCompare;
        return a.description.localeCompare(b.description, "nl");
      });
    case "DESCRIPTION":
      return sorted.sort((a, b) => a.description.localeCompare(b.description, "nl"));
  }
}

// ---------------------------------------------------------------------------
// Top-level aggregaat
// ---------------------------------------------------------------------------

export interface SessionComparisonHeader {
  sessionId: string;
  sessionName: string;
  sessionType: CountSessionType;
  snapshotDate: string;
  completedAt: string | null;
}

export interface SessionComparison {
  headerA: SessionComparisonHeader;
  headerB: SessionComparisonHeader;
  kpis: ComparisonKpis;
  productGroups: ProductGroupComparisonRow[];
  movers: MoversAnalysis;
  /** Sprint 3.1 §6: aparte "Grootste prijsstijgingen/dalingen", gesorteerd op financieel prijseffect op de huidige stock. */
  priceMovers: PriceMoversAnalysis;
  unchanged: UnchangedStockAnalysis;
  obsoleteCandidates: ArticleComparisonRow[];
  obsoleteTransitions: ObsoleteTransitionLists;
  transitionCounts: ArticleTransitionCounts;
  attentionPoints: ComparisonAttentionPoint[];
  /** Volledige detaillijst (unie van A ∪ B) — spec §12. */
  articles: ArticleComparisonRow[];
}

/**
 * Bouwt de volledige vergelijking tussen twee reeds bevroren
 * `StockSnapshot`s. `historyNewestFirstFromB` is de betrouwbare
 * kantoorhistoriek voor de opeenvolgende-tellingen-berekening (spec §8) —
 * MOET beginnen bij B zelf (index 0) en nieuwste-eerst geordend zijn; zie
 * `ReliableHistoryEntry` hierboven. Puur — leest niets, schrijft niets.
 */
export function buildSessionComparison(
  inputA: ComparisonSnapshotInput,
  inputB: ComparisonSnapshotInput,
  historyNewestFirstFromB: ReliableHistoryEntry[],
): SessionComparison {
  const rowsAList = inputA.snapshot.articles.map(toAnalysisArticleRow);
  const rowsBList = inputB.snapshot.articles.map(toAnalysisArticleRow);
  const rowsAById = new Map(rowsAList.map((r) => [r.articleId, r]));
  const rowsBById = new Map(rowsBList.map((r) => [r.articleId, r]));

  const kpis = buildKpis(rowsAList, rowsBList);
  const productGroups = buildProductGroupComparison(rowsAList, rowsBList);

  // Memoiseer per artikel binnen deze ene opbouw (spec §15: geen zware
  // volledige historiekberekening per render/filteractie — dit bestand
  // wordt sowieso maar één keer per (A,B)-paar aangeroepen door de
  // application-laag, en elk artikel wordt hier bovendien maar één keer
  // door de historiek gewandeld).
  const consecutiveCache = new Map<string, ConsecutiveUnchangedResult>();
  function consecutiveFor(articleId: string): ConsecutiveUnchangedResult {
    let cached = consecutiveCache.get(articleId);
    if (!cached) {
      cached = computeConsecutiveUnchanged(articleId, historyNewestFirstFromB);
      consecutiveCache.set(articleId, cached);
    }
    return cached;
  }

  const articles = buildArticleComparisonRows(rowsAById, rowsBById, consecutiveFor);
  const movers = buildMovers(articles);
  const priceMovers = buildPriceMovers(articles);
  const unchanged = buildUnchangedStockAnalysis(articles, kpis.stockValue.valueB);
  const obsoleteCandidates = buildObsoleteCandidates(articles);
  const obsoleteTransitions = buildObsoleteTransitions(articles);
  const transitionCounts = countTransitions(articles);
  const attentionPoints = buildAttentionPoints(kpis, articles, obsoleteCandidates, transitionCounts, obsoleteTransitions);

  return {
    headerA: {
      sessionId: inputA.sessionId,
      sessionName: inputA.sessionName,
      sessionType: inputA.sessionType,
      snapshotDate: inputA.snapshotDate,
      completedAt: inputA.completedAt,
    },
    headerB: {
      sessionId: inputB.sessionId,
      sessionName: inputB.sessionName,
      sessionType: inputB.sessionType,
      snapshotDate: inputB.snapshotDate,
      completedAt: inputB.completedAt,
    },
    kpis,
    productGroups,
    movers,
    priceMovers,
    unchanged,
    obsoleteCandidates,
    obsoleteTransitions,
    transitionCounts,
    attentionPoints,
    articles,
  };
}
