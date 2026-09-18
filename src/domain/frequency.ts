import type {
  Article,
  ArticleActiveStatus,
  ArticleCountFrequency,
  CountSessionType,
} from "./types";

/**
 * Normaliseert de vrije-tekstwaarde uit kolom TELPERIODE naar een vast type.
 * Case-insensitive, whitespace wordt getrimd.
 *
 * Alles wat niet herkend wordt (inclusief leeg/null) valt terug op
 * TO_BE_DETERMINED: we willen dit soort artikelen NOOIT stilletjes negeren,
 * ze moeten zichtbaar zijn in een waarschuwing/review (zie importSummary.ts).
 */
export function normalizeFrequency(raw: string | null | undefined): ArticleCountFrequency {
  const value = (raw ?? "").trim().toUpperCase();
  switch (value) {
    case "MAAND":
      return "MONTHLY";
    case "KWARTAAL":
      return "QUARTERLY";
    case "JAAR":
      return "YEARLY";
    case "NVT":
      return "NOT_APPLICABLE";
    case "NOG TE BEPALEN":
      return "TO_BE_DETERMINED";
    default:
      return "TO_BE_DETERMINED";
  }
}

const INACTIVE_MARKERS = ["INACTIEF", "GEBLOKKEERD", "BLOK", "UITGEFASEERD", "STOPGEZET"];

/**
 * Normaliseert kolom "Artikelstatus" naar ACTIVE/INACTIVE.
 *
 * AANNAME (gedocumenteerd in docs/DATA_MODEL.md): de exacte waardenlijst voor
 * Artikelstatus was niet gespecificeerd. We herkennen een aantal gangbare
 * Nederlandstalige markeringen voor "niet actief"; alles anders (incl. leeg)
 * wordt als ACTIEF beschouwd. Dit is bewust conservatief: liever een artikel
 * te veel tonen dan er één missen.
 */
export function normalizeArticleStatus(raw: string | null | undefined): ArticleActiveStatus {
  const value = (raw ?? "").trim().toUpperCase();
  if (INACTIVE_MARKERS.some((marker) => value.includes(marker))) {
    return "INACTIVE";
  }
  return "ACTIVE";
}

export interface FrequencyBreakdown {
  monthly: number;
  quarterly: number;
  yearly: number;
  notApplicable: number;
  toBeDetermined: number;
  total: number;
}

/** Telt hoeveel (geïmporteerde) artikelen in elke telfrequentie-categorie vallen. */
export function computeFrequencyBreakdown(articles: Article[]): FrequencyBreakdown {
  const breakdown: FrequencyBreakdown = {
    monthly: 0,
    quarterly: 0,
    yearly: 0,
    notApplicable: 0,
    toBeDetermined: 0,
    total: articles.length,
  };
  for (const article of articles) {
    switch (article.countPeriod) {
      case "MONTHLY":
        breakdown.monthly += 1;
        break;
      case "QUARTERLY":
        breakdown.quarterly += 1;
        break;
      case "YEARLY":
        breakdown.yearly += 1;
        break;
      case "NOT_APPLICABLE":
        breakdown.notApplicable += 1;
        break;
      case "TO_BE_DETERMINED":
        breakdown.toBeDetermined += 1;
        break;
    }
  }
  return breakdown;
}

export interface SelectArticlesOptions {
  /** Neem geblokkeerde/inactieve artikelen toch mee. Standaard false. */
  includeInactive?: boolean;
}

/**
 * Bepaalt welke artikelen tot een telling van het gegeven type behoren.
 *
 * MONTHLY:   MAAND
 * QUARTERLY: MAAND + KWARTAAL
 * YEARLY:    MAAND + KWARTAAL + JAAR
 * FULL:      alle (actieve) artikelen, ongeacht telfrequentie —
 *            dit is de enige manier waarop NVT-artikelen meekomen, en
 *            NOG_TE_BEPALEN-artikelen mogen hier ook in zitten.
 *
 * Geblokkeerde/inactieve artikelen worden standaard uitgesloten, ook bij FULL.
 */
export function selectArticlesForSessionType(
  articles: Article[],
  sessionType: CountSessionType,
  options: SelectArticlesOptions = {},
): Article[] {
  const activeArticles = options.includeInactive
    ? articles
    : articles.filter((article) => article.status === "ACTIVE");

  switch (sessionType) {
    case "MONTHLY":
      return activeArticles.filter((article) => article.countPeriod === "MONTHLY");
    case "QUARTERLY":
      return activeArticles.filter(
        (article) => article.countPeriod === "MONTHLY" || article.countPeriod === "QUARTERLY",
      );
    case "YEARLY":
      return activeArticles.filter(
        (article) =>
          article.countPeriod === "MONTHLY" ||
          article.countPeriod === "QUARTERLY" ||
          article.countPeriod === "YEARLY",
      );
    case "FULL":
      return activeArticles;
    default:
      return [];
  }
}

/** Artikelen met TELPERIODE = "nog te bepalen" die om een menselijke review vragen. */
export function articlesNeedingReview(articles: Article[]): Article[] {
  return articles.filter((article) => article.countPeriod === "TO_BE_DETERMINED");
}
