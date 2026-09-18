import type { CountSession } from "./types";

/** Zit dit artikel in de telfrequentie-scope waarmee de sessie gestart is? */
export function isArticleInSessionScope(
  session: Pick<CountSession, "articleIds">,
  articleId: string,
): boolean {
  return session.articleIds.includes(articleId);
}

/**
 * Moet er een waarschuwing getoond worden vóór dit artikel geteld wordt?
 *
 * Ja, wanneer het artikel buiten de sessiescope valt (bv. een kwartaalartikel
 * tijdens een maandtelling) EN er nog geen bestaande telling voor dit
 * artikel op deze locatie is (dan werd de waarschuwing al eerder getoond/
 * bevestigd — niet opnieuw lastigvallen bij het corrigeren van een
 * hoeveelheid). Zie spec v0.1.1 §3 ("+ Ander artikel tellen").
 */
export function requiresOutOfScopeConfirmation(
  session: Pick<CountSession, "articleIds">,
  articleId: string,
  hasExistingEntryAtThisLocation: boolean,
): boolean {
  if (hasExistingEntryAtThisLocation) return false;
  return !isArticleInSessionScope(session, articleId);
}
