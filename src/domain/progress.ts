import type { CountEntry, Location, LocationProgress, SessionProgress } from "./types";

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
    const articleEntries = entriesByArticle.get(articleId);
    if (articleEntries && articleEntries.length > 0 && articleEntries.every((e) => e.counted)) {
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
