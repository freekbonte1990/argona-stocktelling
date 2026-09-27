import { isArticleActiveInAssortment } from "./articleAssortment";
import { selectArticlesForSessionType } from "./frequency";
import type { Article, CountSessionType } from "./types";

/**
 * Sprint 3.3 §2 — Count scope. DE ENE, gecentraliseerde regel voor "hoort
 * dit artikel in een NIEUWE telling (van dit kantoor, van dit sessietype)":
 *
 *   artikel is actief in het assortiment van het kantoor (§1)
 *   EN
 *   artikel behoort tot deze telling volgens de telfrequentie (bestaande
 *   regel, zie `selectArticlesForSessionType` hierboven).
 *
 * Elke aanroeper die de scope van een NIEUWE sessie bepaalt
 * (`CountSessionService#startSession`/`#previewScopes`) MOET via deze
 * functie gaan — nooit rechtstreeks `selectArticlesForSessionType` voor een
 * nieuwe telling, want dat zou historische/niet-assortiment-artikelen
 * opnieuw laten meetellen zodra ze toevallig weer de juiste telfrequentie
 * hebben.
 *
 * Raakt bewust NIET de bestaande "buiten-scope"-flows
 * (`domain/sessionScope.ts#requiresOutOfScopeConfirmation`, "+ Bestaand
 * artikel opzoeken", "+ Nieuw artikel gevonden" via `NewArticleService`): een
 * gebruiker kan tijdens een lopende telling nog altijd expliciet een artikel
 * buiten-scope tellen/toevoegen — dat is een bewuste, menselijke
 * uitzondering, geen sluipend gat in deze regel. Een artikel dat zo
 * gevonden wordt, verschijnt gewoon in Review als handmatige toevoeging
 * (ongewijzigd gedrag) — dit bestand bepaalt enkel de AUTOMATISCHE
 * startscope van een nieuwe sessie.
 */
export function selectArticlesForNewCount(articles: Article[], sessionType: CountSessionType): Article[] {
  const inAssortment = articles.filter((article) => isArticleActiveInAssortment(article));
  return selectArticlesForSessionType(inAssortment, sessionType);
}
