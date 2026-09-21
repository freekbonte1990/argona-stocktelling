import type { Article } from "./types";

/**
 * Sorteermodi voor het browsen van artikelen op een locatie (spec v0.2.1
 * §2): "Productgroep -> Omschrijving" is de standaard, daarnaast kan de
 * gebruiker op enkel Omschrijving of op Artikelnummer sorteren. Dit is
 * ORTHOGONAAL aan de "verwacht op deze locatie eerst"-tiering hieronder
 * (spec §9) — de gekozen modus bepaalt enkel de volgorde BINNEN elke tier.
 */
export type ArticleSortMode = "GROUP_THEN_DESCRIPTION" | "DESCRIPTION" | "ARTICLE_NUMBER";

export const ARTICLE_SORT_MODE_LABELS: Record<ArticleSortMode, string> = {
  GROUP_THEN_DESCRIPTION: "Productgroep",
  DESCRIPTION: "Omschrijving",
  ARTICLE_NUMBER: "Artikelnummer",
};

function compareByMode(a: Article, b: Article, mode: ArticleSortMode): number {
  switch (mode) {
    case "GROUP_THEN_DESCRIPTION": {
      const groupCompare = (a.productGroup ?? "").localeCompare(b.productGroup ?? "", "nl");
      if (groupCompare !== 0) return groupCompare;
      return a.description.localeCompare(b.description, "nl");
    }
    case "DESCRIPTION":
      return a.description.localeCompare(b.description, "nl");
    case "ARTICLE_NUMBER":
      return a.articleNumber.localeCompare(b.articleNumber, "nl", { numeric: true });
  }
}

/**
 * Standaard sortering binnen een locatie (spec v0.2 §12, uitgebreid met
 * sorteermodus in v0.2.1 §2):
 *   1. verwacht op deze locatie (ArticleLocationAssignment) eerst
 *   2. de gekozen sorteermodus (standaard: Productgroep -> Omschrijving)
 */
export function sortArticlesForLocation(
  articles: Article[],
  expectedArticleIds: Set<string>,
  mode: ArticleSortMode = "GROUP_THEN_DESCRIPTION",
): Article[] {
  return [...articles].sort((a, b) => {
    const aExpected = expectedArticleIds.has(a.id) ? 0 : 1;
    const bExpected = expectedArticleIds.has(b.id) ? 0 : 1;
    if (aExpected !== bExpected) return aExpected - bExpected;

    return compareByMode(a, b, mode);
  });
}
