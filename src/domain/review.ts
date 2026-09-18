import { isArticleFullyCounted } from "./progress";
import type { Article, CountEntry, CountSession, Location } from "./types";

/**
 * Resultaatberekening voor het reviewscherm (v0.2 §1-3) en voor de
 * Excel-export (v0.2 §5). Alles hier is PURE domeinlogica: geen React,
 * geen Excel, geen IndexedDB. `ExcelStockResultExporter` mag deze module
 * enkel consumeren, nooit zelf herberekenen (spec: "schrijf geen
 * businesslogica rechtstreeks in de Excel-adapter").
 */

/** Waarde van één artikel op één locatie, met hetzelfde onderscheid als CountEntry: */
export interface LocationCountValue {
  locationId: string;
  locationNumber: 1 | 2 | 3 | 4 | 5;
  /** null = geen entry op deze locatie (nooit verwacht/geteld hier). */
  quantity: number | null;
  counted: boolean;
  /**
   * True zodra er een CountEntry bestaat op deze locatie voor dit artikel —
   * ongeacht of die al `counted` is. Onderscheidt "hier nog te tellen" van
   * "hier nooit verwacht", iets wat `quantity`/`counted` alleen niet kunnen
   * (beide zijn identiek — null/false — in de twee gevallen). Nodig voor de
   * "terug naar het artikel om te hertellen"-navigatie in het reviewscherm
   * (spec §3): enkel een locatie met een entry heeft iets om naar terug te
   * navigeren.
   */
  hasEntry: boolean;
}

export interface ArticleReviewResult {
  articleId: string;
  article: Article;
  /** Voorheen "vorige telling" (Article.previousCount, ongewijzigd voor dit scherm). */
  previousCount: number | null;
  perLocation: LocationCountValue[];
  /**
   * Volledig geteld = minstens 1 entry EN alle entries voor dit artikel in
   * deze sessie zijn `counted: true`. Zie `progress.ts#isArticleFullyCounted`.
   * Bij `false` is `newTotalCount`/`differenceQuantity`/`differenceAmount`
   * altijd `null` — NOOIT 0 (spec §3, kernregel van de hele app).
   */
  fullyCounted: boolean;
  /** Som van de quantity's van alle (getelde) locatie-entries. Null tot volledig geteld. */
  newTotalCount: number | null;
  differenceQuantity: number | null;
  costPrice: number | null;
  /** Waarde van de vorige telling (previousCount * costPrice) — "Waarde vorige telling" in TELLING. */
  previousValue: number | null;
  /** Waarde van de nieuwe totale telling (newTotalCount * costPrice) — "Bedrag" in TELLING. */
  amount: number | null;
  differenceAmount: number | null;
  /** Eerste niet-lege notitie onder de entries van dit artikel (bv. "buiten sessiescope"). */
  note: string | null;
  /**
   * True als dit artikel niet in `CountSession.articleIds` zit — d.w.z. het
   * is via "+ Ander artikel tellen" buiten de sessiescope toegevoegd
   * (spec v0.1.1 §3). Zo'n artikel telt niet mee in de scope-totalen, maar
   * verschijnt wel in de resultatenlijst (het is effectief geteld en moet
   * dus ook in de Excel-export terechtkomen).
   */
  isManualAddition: boolean;
  /**
   * AANNAME (gedocumenteerd, want toekomstige impact): het filter
   * "Controle" (spec §1) heeft geen exacte definitie meegekregen. We
   * gebruiken hiervoor het bestaande notitie-mechanisme: een artikel met
   * een notitie is er één die een mens bewust heeft moeten toevoegen
   * (vandaag enkel de "buiten sessiescope"-bevestiging) en dus een tweede
   * blik verdient vóór het afronden. Geen nieuwe drempelwaarde/threshold
   * uitgevonden — bewust eenvoudig gehouden.
   */
  flaggedForControl: boolean;
}

export interface SessionReviewSummary {
  /** Enkel artikelen in `CountSession.articleIds` — spec §1: "totaal artikels in sessiescope". */
  totalArticlesInScope: number;
  countedArticles: number;
  notCountedArticles: number;
  /** Aantal artikelen (in scope) met een verschil (positief of negatief) t.o.v. de vorige telling. */
  articlesWithDifference: number;
  totalPositiveCorrectionQuantity: number;
  totalNegativeCorrectionQuantity: number;
  totalPositiveCorrectionAmount: number;
  totalNegativeCorrectionAmount: number;
  /**
   * Scope-artikelen + eventuele handmatige buiten-scope-toevoegingen. Dit is
   * de volledige lijst die het reviewscherm en de Excel-export gebruiken.
   */
  results: ArticleReviewResult[];
}

export type ReviewFilter = "ALL" | "DIFFERENCE" | "CONTROL" | "NOT_COUNTED";

function buildLocationValues(
  locations: Location[],
  entriesForArticle: CountEntry[],
): LocationCountValue[] {
  const byLocationId = new Map(entriesForArticle.map((entry) => [entry.locationId, entry]));
  return locations.map((location) => {
    const entry = byLocationId.get(location.id);
    return {
      locationId: location.id,
      locationNumber: location.number,
      quantity: entry?.quantity ?? null,
      counted: entry?.counted ?? false,
      hasEntry: entry !== undefined,
    };
  });
}

function buildArticleReviewResult(
  article: Article,
  locations: Location[],
  entriesForArticle: CountEntry[],
  isManualAddition: boolean,
): ArticleReviewResult {
  const fullyCounted = isArticleFullyCounted(entriesForArticle);
  const perLocation = buildLocationValues(locations, entriesForArticle);

  const newTotalCount = fullyCounted
    ? perLocation.reduce((sum, loc) => sum + (loc.quantity ?? 0), 0)
    : null;
  const previousCount = article.previousCount;
  const differenceQuantity =
    fullyCounted && newTotalCount !== null ? newTotalCount - (previousCount ?? 0) : null;
  const costPrice = article.costPrice;
  const previousValue = previousCount !== null && costPrice !== null ? previousCount * costPrice : null;
  const amount = newTotalCount !== null && costPrice !== null ? newTotalCount * costPrice : null;
  const differenceAmount =
    differenceQuantity !== null && costPrice !== null ? differenceQuantity * costPrice : null;
  const note = entriesForArticle.find((e) => e.note)?.note ?? null;

  return {
    articleId: article.id,
    article,
    previousCount,
    perLocation,
    fullyCounted,
    newTotalCount,
    differenceQuantity,
    costPrice,
    previousValue,
    amount,
    differenceAmount,
    note,
    isManualAddition,
    flaggedForControl: note !== null,
  };
}

/**
 * Berekent het volledige reviewresultaat van een sessie: één rij per
 * scope-artikel, plus één rij per handmatige buiten-scope-toevoeging die
 * effectief geteld werd.
 */
export function computeSessionReview(
  session: Pick<CountSession, "articleIds">,
  articles: Article[],
  locations: Location[],
  entries: CountEntry[],
): SessionReviewSummary {
  const articleById = new Map(articles.map((a) => [a.id, a]));
  const entriesByArticle = new Map<string, CountEntry[]>();
  for (const entry of entries) {
    const list = entriesByArticle.get(entry.articleId);
    if (list) list.push(entry);
    else entriesByArticle.set(entry.articleId, [entry]);
  }

  const scopeIds = new Set(session.articleIds);
  const results: ArticleReviewResult[] = [];

  for (const articleId of session.articleIds) {
    const article = articleById.get(articleId);
    if (!article) continue; // artikel niet (meer) gevonden — kan niet gebeuren zolang articles nooit verwijderd worden.
    results.push(
      buildArticleReviewResult(article, locations, entriesByArticle.get(articleId) ?? [], false),
    );
  }

  // Handmatige buiten-scope-toevoegingen: elk articleId met entries dat niet
  // in de sessiescope zit.
  for (const [articleId, articleEntries] of entriesByArticle) {
    if (scopeIds.has(articleId)) continue;
    const article = articleById.get(articleId);
    if (!article) continue;
    results.push(buildArticleReviewResult(article, locations, articleEntries, true));
  }

  let countedArticles = 0;
  let articlesWithDifference = 0;
  let totalPositiveCorrectionQuantity = 0;
  let totalNegativeCorrectionQuantity = 0;
  let totalPositiveCorrectionAmount = 0;
  let totalNegativeCorrectionAmount = 0;

  for (const result of results) {
    if (result.isManualAddition) continue; // scope-totalen gaan enkel over sessiescope-artikelen.
    if (result.fullyCounted) countedArticles += 1;
    if (result.differenceQuantity !== null && result.differenceQuantity !== 0) {
      articlesWithDifference += 1;
      if (result.differenceQuantity > 0) {
        totalPositiveCorrectionQuantity += result.differenceQuantity;
      } else {
        totalNegativeCorrectionQuantity += result.differenceQuantity;
      }
    }
    if (result.differenceAmount !== null && result.differenceAmount !== 0) {
      if (result.differenceAmount > 0) {
        totalPositiveCorrectionAmount += result.differenceAmount;
      } else {
        totalNegativeCorrectionAmount += result.differenceAmount;
      }
    }
  }

  return {
    totalArticlesInScope: session.articleIds.length,
    countedArticles,
    notCountedArticles: session.articleIds.length - countedArticles,
    articlesWithDifference,
    totalPositiveCorrectionQuantity,
    totalNegativeCorrectionQuantity,
    totalPositiveCorrectionAmount,
    totalNegativeCorrectionAmount,
    results,
  };
}

export function filterReviewResults(
  results: ArticleReviewResult[],
  filter: ReviewFilter,
): ArticleReviewResult[] {
  switch (filter) {
    case "ALL":
      return results;
    case "DIFFERENCE":
      return results.filter((r) => r.differenceQuantity !== null && r.differenceQuantity !== 0);
    case "CONTROL":
      return results.filter((r) => r.flaggedForControl);
    case "NOT_COUNTED":
      return results.filter((r) => !r.fullyCounted);
  }
}

/**
 * Spec §4: standaard enkel afronden als alle artikelen in scope afgewerkt
 * zijn. Handmatige buiten-scope-toevoegingen blokkeren dit nooit (die zijn
 * per definitie al geteld op het moment dat ze ontstaan — zie CountingService).
 */
export function isSessionReadyToComplete(summary: SessionReviewSummary): boolean {
  return summary.notCountedArticles === 0;
}

/**
 * Voor de Excel-export (§5): "de nieuwe totale telling moet bij een
 * volgende import als vorige telling kunnen dienen". Dit bouwt, voor ELK
 * artikel van het kantoor (niet enkel de sessiescope — een kwartaalartikel
 * dat deze maand niet meetelt, mag zijn oude previousCount niet verliezen),
 * de waarde die in de geëxporteerde ARTIKEL-sheet als "Vorige telling"
 * terechtkomt.
 */
export function buildNextPreviousCounts(
  allArticles: Article[],
  results: ArticleReviewResult[],
): Map<string, number | null> {
  const byId = new Map(results.map((r) => [r.articleId, r]));
  const next = new Map<string, number | null>();
  for (const article of allArticles) {
    const result = byId.get(article.id);
    next.set(article.id, result?.fullyCounted ? result.newTotalCount : article.previousCount);
  }
  return next;
}
