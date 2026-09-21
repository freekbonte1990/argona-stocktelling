import type { Article, ArticleActiveStatus, ArticleCountFrequency } from "./types";

/**
 * Sorteer- en filtermodi voor het Artikels-overzicht (v0.2.1: snellere
 * bulk-locatietoewijzing, spec §5-6).
 *
 * Bewust een APART bestand t.o.v. domain/sorting.ts: die laatste is
 * specifiek voor het TELSCHERM (met de "verwacht op deze locatie eerst"-
 * tiering, spec §9) — hier gaat het om het volledige artikeloverzicht,
 * zonder die locatiegebonden voorrang, en met extra sorteer-/filtervelden
 * (telfrequentie, vorige telling, locatie, status) die het telscherm niet
 * nodig heeft.
 */
export type ArticleListSortMode =
  | "GROUP_THEN_DESCRIPTION"
  | "DESCRIPTION_ASC"
  | "DESCRIPTION_DESC"
  | "ARTICLE_NUMBER"
  | "COUNT_PERIOD"
  | "PREVIOUS_COUNT";

export const ARTICLE_LIST_SORT_MODE_LABELS: Record<ArticleListSortMode, string> = {
  GROUP_THEN_DESCRIPTION: "Productgroep → Omschrijving",
  DESCRIPTION_ASC: "Omschrijving A-Z",
  DESCRIPTION_DESC: "Omschrijving Z-A",
  ARTICLE_NUMBER: "Artikelnummer",
  COUNT_PERIOD: "Telfrequentie",
  PREVIOUS_COUNT: "Vorige telling",
};

const FREQUENCY_ORDER: Record<ArticleCountFrequency, number> = {
  MONTHLY: 0,
  QUARTERLY: 1,
  YEARLY: 2,
  NOT_APPLICABLE: 3,
  TO_BE_DETERMINED: 4,
};

export const FREQUENCY_FILTER_LABELS: Record<ArticleCountFrequency, string> = {
  MONTHLY: "Maand",
  QUARTERLY: "Kwartaal",
  YEARLY: "Jaar",
  NOT_APPLICABLE: "N.v.t.",
  TO_BE_DETERMINED: "Nog te bepalen",
};

export const ARTICLE_STATUS_FILTER_LABELS: Record<ArticleActiveStatus, string> = {
  ACTIVE: "Actief",
  INACTIVE: "Inactief",
};

/** Standaard sortering van het Artikels-overzicht (spec §5): Productgroep → Omschrijving. */
export const DEFAULT_ARTICLE_LIST_SORT_MODE: ArticleListSortMode = "GROUP_THEN_DESCRIPTION";

export function sortArticlesForList(articles: Article[], mode: ArticleListSortMode): Article[] {
  return [...articles].sort((a, b) => {
    switch (mode) {
      case "GROUP_THEN_DESCRIPTION": {
        const groupCompare = (a.productGroup ?? "").localeCompare(b.productGroup ?? "", "nl");
        if (groupCompare !== 0) return groupCompare;
        return a.description.localeCompare(b.description, "nl");
      }
      case "DESCRIPTION_ASC":
        return a.description.localeCompare(b.description, "nl");
      case "DESCRIPTION_DESC":
        return b.description.localeCompare(a.description, "nl");
      case "ARTICLE_NUMBER":
        return a.articleNumber.localeCompare(b.articleNumber, "nl", { numeric: true });
      case "COUNT_PERIOD": {
        const diff = FREQUENCY_ORDER[a.countPeriod] - FREQUENCY_ORDER[b.countPeriod];
        if (diff !== 0) return diff;
        return a.description.localeCompare(b.description, "nl");
      }
      case "PREVIOUS_COUNT": {
        // Onbekend (nooit geteld, previousCount = null) telt als laagste —
        // hoogste vorige telling eerst, zodat je snel de "grote" artikelen ziet.
        const aValue = a.previousCount ?? -Infinity;
        const bValue = b.previousCount ?? -Infinity;
        if (aValue !== bValue) return bValue - aValue;
        return a.description.localeCompare(b.description, "nl");
      }
      default:
        return 0;
    }
  });
}

/** "ALL" = geen locatiefilter, "NONE" = nog geen enkele actieve locatie, of een specifiek locatie-ID. */
export type ArticleLocationFilterValue = "ALL" | "NONE" | string;

export interface ArticleListFilters {
  search: string;
  productGroup: string | null;
  countPeriod: ArticleCountFrequency | null;
  status: ArticleActiveStatus | null;
  location: ArticleLocationFilterValue;
}

export const DEFAULT_ARTICLE_LIST_FILTERS: ArticleListFilters = {
  search: "",
  productGroup: null,
  countPeriod: null,
  status: null,
  location: "ALL",
};

/**
 * Aantal actieve filters t.o.v. `DEFAULT_ARTICLE_LIST_FILTERS` (v0.2.1
 * correctieronde §1: de "Filters"-knop mag het aantal actieve filters tonen,
 * bv. "Filters (2)", zonder tientallen chips permanent boven de lijst te
 * tonen). Zoekterm telt bewust niet mee — die heeft al zijn eigen, altijd
 * zichtbare invoerveld en is geen "filter" in de zin van deze knop.
 */
export function countActiveArticleListFilters(filters: ArticleListFilters): number {
  let count = 0;
  if (filters.productGroup !== null) count += 1;
  if (filters.countPeriod !== null) count += 1;
  if (filters.status !== null) count += 1;
  if (filters.location !== "ALL") count += 1;
  return count;
}

/**
 * Filtert artikelen voor het overzicht (spec §6). `locationIdsByArticle`
 * bevat, per artikel, de huidige ACTIEVE gekoppelde locatie-ID's (spec:
 * "Geen locatie" moet tonen welke artikelen nog nergens ingedeeld zijn —
 * dat gaat over actieve koppelingen, nooit over historische/inactieve).
 */
export function filterArticlesForList(
  articles: Article[],
  filters: ArticleListFilters,
  locationIdsByArticle: Map<string, Set<string>>,
): Article[] {
  const term = filters.search.trim().toLowerCase();
  return articles.filter((article) => {
    if (filters.productGroup && article.productGroup !== filters.productGroup) return false;
    if (filters.countPeriod && article.countPeriod !== filters.countPeriod) return false;
    if (filters.status && article.status !== filters.status) return false;

    if (filters.location === "NONE") {
      const locations = locationIdsByArticle.get(article.id);
      if (locations && locations.size > 0) return false;
    } else if (filters.location !== "ALL") {
      const locations = locationIdsByArticle.get(article.id);
      if (!locations || !locations.has(filters.location)) return false;
    }

    if (term) {
      const haystack = `${article.articleNumber} ${article.description}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}
