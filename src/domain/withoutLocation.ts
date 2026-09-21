import type { Article, ArticleLocationAssignment, CountSession } from "./types";

/**
 * "Zonder locatie" (v0.2.1 correctieronde): een DYNAMISCHE werklijst, geen
 * fysieke locatie. Bewust geen `Location`-record — er wordt hier nergens
 * iets aan `office.locations` toegevoegd of opgeslagen; dit is puur een
 * berekening bovenop reeds bestaande data (sessiescope + huidige actieve
 * `ArticleLocationAssignment`'s), telkens opnieuw afgeleid.
 *
 * Scope is bewust `session.articleIds` (de sessiescope), NIET alle
 * artikelen van het kantoor: een artikel dat toevallig geen locatie heeft
 * maar niet in deze telling zit (bv. een andere telfrequentie) hoort hier
 * niet bij. Handmatige buiten-scope-toevoegingen (spec v0.2 §3) zitten per
 * definitie ook niet in `session.articleIds`, en verschijnen dus terecht
 * niet in deze lijst.
 */
export function articlesWithoutLocation(
  articles: Article[],
  session: Pick<CountSession, "articleIds">,
  assignments: ArticleLocationAssignment[],
): Article[] {
  const assignedArticleIds = new Set(
    assignments.filter((assignment) => assignment.active).map((assignment) => assignment.articleId),
  );
  const scopeIds = new Set(session.articleIds);
  return articles.filter((article) => scopeIds.has(article.id) && !assignedArticleIds.has(article.id));
}
