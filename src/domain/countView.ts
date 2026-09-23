/**
 * v0.3 §1-3: pure logica voor de versnelde tel-flow op het telscherm. Puur
 * domein (geen React, geen IndexedDB) zodat de kernregels — welke weergave
 * standaard geopend wordt, welk artikel "het volgende" is, welk artikel
 * zichtbaar blijft in een bepaalde weergave — apart en snel getest kunnen
 * worden van de DOM/focus-mechaniek in CountingPage.tsx.
 */

/**
 * Primaire weergave-tabs op het telscherm (spec v0.3 §3):
 *   TODO                 -> "Nog te tellen": nog niet geteld OP DEZE locatie.
 *   ALL                  -> "Alles": geen filtering — de bestaande brede
 *                            browse-flow (nodig tijdens leermodus, spec §3).
 *   DONE                 -> "Geteld": al geteld op deze locatie — hier kan
 *                            een artikel opnieuw geopend/herteld worden.
 *   NOT_COUNTED_ANYWHERE  -> bestaand filter uit v0.2.1 (§2), ongewijzigd
 *                            behouden: nog nergens in de hele sessie geteld
 *                            (dus ook niet op een andere locatie).
 */
export type CountFilter = "TODO" | "ALL" | "DONE" | "NOT_COUNTED_ANYWHERE";

export const COUNT_FILTER_LABELS: Record<CountFilter, string> = {
  TODO: "Nog te tellen",
  ALL: "Alles",
  DONE: "Geteld",
  NOT_COUNTED_ANYWHERE: "Nog nergens geteld",
};

/**
 * Standaard weergave bij het openen van een locatie (spec v0.3 §3):
 *   - eerste telling zonder locatiehistoriek (leermodus): de bestaande brede
 *     browse-flow blijft de standaard ("Alles") — er is nog geen zinvolle
 *     "nog te tellen"-deelverzameling zolang niets geleerd is.
 *   - normale telling met gekende assignments: standaard "Nog te tellen",
 *     zodat de gebruiker meteen het resterende werk ziet.
 */
export function defaultCountFilter(isLearningMode: boolean): CountFilter {
  return isLearningMode ? "ALL" : "TODO";
}

/** Is dit artikel, gegeven het gekozen filter, zichtbaar in de huidige weergave? */
export function matchesCountFilter(
  filter: CountFilter,
  countedHere: boolean,
  hasAnyEntryAnywhere: boolean,
): boolean {
  switch (filter) {
    case "TODO":
      return !countedHere;
    case "DONE":
      return countedHere;
    case "NOT_COUNTED_ANYWHERE":
      return !hasAnyEntryAnywhere;
    case "ALL":
      return true;
  }
}

/**
 * Eerstvolgende item ná `afterIndex` waarvoor `isCounted` nog false is (spec
 * v0.3 §2: "scroll/focus automatisch naar het volgende nog niet getelde
 * artikel"). Generiek gehouden (niet specifiek aan Article/CountEntry
 * gekoppeld) zodat dit apart en zonder DOM getest kan worden.
 */
export function findNextTodoItem<T>(
  items: T[],
  afterIndex: number,
  isCounted: (item: T) => boolean,
): T | undefined {
  return items.slice(afterIndex + 1).find((item) => !isCounted(item));
}
