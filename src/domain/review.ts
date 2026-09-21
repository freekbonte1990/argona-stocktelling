import { isArticleFullyCounted } from "./progress";
import type {
  Article,
  CountEntry,
  CountSession,
  Location,
  LocationSessionStatus,
} from "./types";

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
  /** Weergavevolgorde van de locatie (v0.2.1: dynamisch aantal, geen vaste 1-5 meer). */
  locationNumber: number;
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
   * is via "+ Bestaand artikel opzoeken" buiten de sessiescope toegevoegd
   * (spec v0.1.1 §3). Zo'n artikel telt niet mee in de scope-totalen, maar
   * verschijnt wel in de resultatenlijst (het is effectief geteld en moet
   * dus ook in de Excel-export terechtkomen).
   */
  isManualAddition: boolean;
  /** True zolang dit artikel deze sessie nog geen ENKELE entry heeft (nergens geteld, ook niet bevestigd afwezig). */
  hasAnyEntry: boolean;
  /** True wanneer dit artikel expliciet bevestigd is als "niet aanwezig — voorraad 0" (spec v0.2.1 §5). */
  confirmedAbsent: boolean;
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
  /**
   * Zijn alle ACTIEVE locaties van dit kantoor voor deze sessie op
   * `COMPLETED` gezet? Pas dan is `notFoundAnywhere` betrouwbaar (spec
   * v0.2.1 §5: "pas nadat alle relevante locaties afgerond zijn, kunnen we
   * weten welke artikels nergens gevonden werden"). De UI moet de
   * bevestigingsacties op `notFoundAnywhere` verbergen/uitschakelen zolang
   * dit `false` is — de lijst zelf mag altijd informatief getoond worden.
   */
  allLocationsCompleted: boolean;
  /** Aantal actieve locaties van dit kantoor — voor de "X / Y locaties afgerond"-teller (spec v0.2.1 §6). */
  totalActiveLocations: number;
  /** Aantal actieve locaties dat voor deze sessie al COMPLETED is. */
  completedActiveLocationsCount: number;
  /**
   * De actieve locaties die nog NIET COMPLETED zijn voor deze sessie, in
   * weergavevolgorde (spec v0.2.1 §6, afrondvoorwaarde 1). Leeg zodra
   * `allLocationsCompleted` true is. Gebruikt door de UI om zowel de
   * duidelijke foutmelding ("2 locaties zijn nog niet afgerond: ...") als
   * rechtstreekse links naar die locaties op te bouwen.
   */
  incompleteActiveLocations: Location[];
  /**
   * Scope-artikelen (geen handmatige buiten-scope-toevoegingen — die hebben
   * per definitie altijd al een entry) zonder enige entry deze sessie: nog
   * nergens geteld én nog niet bevestigd afwezig.
   */
  notFoundAnywhere: ArticleReviewResult[];
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

  // Som over ALLE entries (niet enkel de locatie-gebonden) — een bevestigd-
  // afwezig artikel (resolution CONFIRMED_ABSENT, locationId null) draagt
  // zijn (altijd 0) hoeveelheid zo ook correct bij, zonder een fictieve
  // locatie te moeten verzinnen.
  const newTotalCount = fullyCounted
    ? entriesForArticle.reduce((sum, entry) => sum + (entry.counted ? entry.quantity ?? 0 : 0), 0)
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
    hasAnyEntry: entriesForArticle.length > 0,
    confirmedAbsent: entriesForArticle.some((e) => e.resolution === "CONFIRMED_ABSENT"),
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
  /** Locatiestatussen van deze sessie (spec v0.2.1 §4-5) — leeg toegestaan (bv. oudere aanroepers/tests). */
  locationStatuses: LocationSessionStatus[] = [],
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

  const activeLocations = locations.filter((l) => l.active);
  const statusByLocationId = new Map(locationStatuses.map((s) => [s.locationId, s.status]));
  const allLocationsCompleted =
    activeLocations.length > 0 &&
    activeLocations.every((l) => statusByLocationId.get(l.id) === "COMPLETED");
  const incompleteActiveLocations = activeLocations
    .filter((l) => statusByLocationId.get(l.id) !== "COMPLETED")
    .sort((a, b) => a.number - b.number);

  const notFoundAnywhere = results.filter(
    (result) => !result.isManualAddition && !result.hasAnyEntry,
  );

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
    allLocationsCompleted,
    totalActiveLocations: activeLocations.length,
    completedActiveLocationsCount: activeLocations.length - incompleteActiveLocations.length,
    incompleteActiveLocations,
    notFoundAnywhere,
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
 * Spec v0.2.1 §6: een telling mag pas definitief afgerond worden wanneer
 * BEIDE voorwaarden vervuld zijn:
 *   1. Alle actieve fysieke locaties zijn expliciet afgerond
 *      (`allLocationsCompleted` — "Zonder locatie" en inactieve locaties
 *      tellen hier per definitie niet mee, zie `computeSessionReview`).
 *   2. Alle artikelen in de telling zijn opgelost: volledig geteld, of
 *      expliciet bevestigd als "niet aanwezig / voorraad 0"
 *      (`notCountedArticles === 0` — handmatige buiten-scope-toevoegingen
 *      blokkeren dit nooit, die zijn per definitie al geteld op het moment
 *      dat ze ontstaan, zie CountingService).
 * Beide voorwaarden worden telkens vers herberekend uit de actuele
 * locatiestatussen/entries (nooit gecached bij sessiestart), dus het
 * heropenen van een eerder afgeronde locatie maakt de sessie automatisch
 * opnieuw niet-afrondbaar totdat die locatie opnieuw afgerond wordt.
 */
export function isSessionReadyToComplete(summary: SessionReviewSummary): boolean {
  return summary.notCountedArticles === 0 && summary.allLocationsCompleted;
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
