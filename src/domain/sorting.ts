import type { Article } from "./types";

/**
 * Standaard sortering binnen een locatie (spec §12):
 *   1. verwacht op deze locatie (ArticleLocationAssignment) eerst
 *   2. Productgroep
 *   3. Omschrijving
 */
export function sortArticlesForLocation(articles: Article[], expectedArticleIds: Set<string>): Article[] {
  return [...articles].sort((a, b) => {
    const aExpected = expectedArticleIds.has(a.id) ? 0 : 1;
    const bExpected = expectedArticleIds.has(b.id) ? 0 : 1;
    if (aExpected !== bExpected) return aExpected - bExpected;

    const groupCompare = (a.productGroup ?? "").localeCompare(b.productGroup ?? "", "nl");
    if (groupCompare !== 0) return groupCompare;

    return a.description.localeCompare(b.description, "nl");
  });
}
