import type { CountEntry, Location, LocationProgress, SessionProgress } from "./types";

/**
 * Eén artikel is pas "volledig geteld" als er minstens één CountEntry voor
 * bestaat binnen de sessie EN al die entries `counted: true` zijn. Een
 * artikel zonder enige entry (nog nooit ergens geteld) telt NOOIT als
 * volledig geteld — dit is de kern van de "niet-geteld mag nooit als 0"-
 * regel (spec v0.2 §3) en wordt hier centraal gehouden zodat
 * `computeSessionProgress` en `domain/review.ts#computeSessionReview` exact
 * dezelfde definitie gebruiken.
 *
 * Uitzondering (production-pilot-readiness sprint punt 3, "Nergens
 * aangetroffen"-stub-entry-bugfix): een `CONFIRMED_ABSENT`-entry is een
 * uitspraak over het HELE kantoor ("dit artikel is nergens aangetroffen"),
 * niet over één rek (zie `types.ts#ArticleCountResolution`). Een artikel dat
 * op meerdere locaties verwacht wordt, krijgt bij sessiestart voor elk van
 * die locaties al een niet-getelde stub-`CountEntry`
 * (`CountSessionService#buildInitialEntries`). Zonder deze uitzondering zou
 * zo'n artikel NOOIT "volledig geteld" kunnen worden via `confirmAbsent` —
 * de resterende, nooit aangeraakte stub-entries op de andere locaties
 * blokkeren dan voor altijd `entries.every(counted)`, ook al heeft de
 * gebruiker net expliciet bevestigd dat dit artikel nergens ligt. Eén
 * bevestigd-afwezig-entry maakt daarom het hele artikel "opgelost",
 * ongeacht resterende stub-entries elders.
 */
export function isArticleFullyCounted(entries: CountEntry[] | undefined): boolean {
  if (!entries || entries.length === 0) return false;
  if (entries.some((entry) => entry.counted && entry.resolution === "CONFIRMED_ABSENT")) {
    return true;
  }
  return entries.every((entry) => entry.counted);
}

/**
 * Berekent voortgang van een telling.
 *
 * LET OP (zie ook spec §8): een artikel kan op meerdere locaties tegelijk
 * verwacht worden. Er bestaat dus geen naïeve "som van alle location-entries"
 * die gelijk staat aan "aantal unieke afgewerkte artikelen". Deze functie
 * berekent daarom BEIDE:
 *   - locatie-entry voortgang (kan een artikel dubbel meetellen)
 *   - unieke-artikel voortgang (een artikel is pas "af" als het op AL zijn
 *     gekende locaties voor deze sessie geteld is)
 *
 * Een artikel waarvoor nog geen enkele CountEntry bestaat (nog nooit ergens
 * geteld, geen gekende locatie) telt niet mee als afgewerkt.
 */
export function computeSessionProgress(
  articleIds: string[],
  locations: Location[],
  entries: CountEntry[],
): SessionProgress {
  const perLocation: LocationProgress[] = locations.map((location) => {
    const locationEntries = entries.filter((entry) => entry.locationId === location.id);
    return {
      locationId: location.id,
      totalEntries: locationEntries.length,
      countedEntries: locationEntries.filter((entry) => entry.counted).length,
    };
  });

  const entriesByArticle = new Map<string, CountEntry[]>();
  for (const entry of entries) {
    const list = entriesByArticle.get(entry.articleId);
    if (list) {
      list.push(entry);
    } else {
      entriesByArticle.set(entry.articleId, [entry]);
    }
  }

  let completedUniqueArticles = 0;
  for (const articleId of articleIds) {
    if (isArticleFullyCounted(entriesByArticle.get(articleId))) {
      completedUniqueArticles += 1;
    }
  }

  return {
    totalLocationEntries: entries.length,
    countedLocationEntries: entries.filter((entry) => entry.counted).length,
    totalUniqueArticles: articleIds.length,
    completedUniqueArticles,
    perLocation,
  };
}
