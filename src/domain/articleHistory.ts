import { isArticleFullyCounted } from "./progress";
import type { CountEntry, CountSession, Location } from "./types";

/**
 * Eén historisch punt voor de evolutie/historiek van één artikel (spec
 * v0.2.1 §7-8): het resultaat van precies één AFGERONDE telsessie waarin dit
 * artikel volledig geteld was (incl. expliciet-afwezig=0 — dat is een
 * geldige telling, zie `progress.ts#isArticleFullyCounted`). Een sessie
 * waarin dit artikel niet (volledig) geteld werd, levert bewust GEEN punt op
 * — er wordt nooit een geschatte/afgeleide waarde getoond (spec §8: "enkel
 * echte historische tellingen, geen geschatte waarden").
 */
export interface ArticleHistoryPoint {
  sessionId: string;
  /** Datum waarop de telsessie werd afgerond (ISO) — dit IS de teldatum. */
  date: string;
  totalCount: number;
  /** null voor het eerste historische punt (geen vorige telling om mee te vergelijken). */
  difference: number | null;
  /** Namen van de locatie(s) waar dit artikel toen geteld werd, alfabetisch. Leeg bij een bevestigd-afwezige telling. */
  locationNames: string[];
}

/**
 * Bouwt de chronologische (oudste eerst) historiek van één artikel over alle
 * afgeronde sessies van een kantoor heen. Puur domeinlogica — geen React,
 * geen Dexie: de UI (zie ui/hooks/useLiveData.ts#useArticleHistory) haalt de
 * sessies/entries/locaties op en roept dit enkel aan om te berekenen.
 */
export function buildArticleHistory(
  articleId: string,
  completedSessions: CountSession[],
  entriesBySessionId: Map<string, CountEntry[]>,
  locations: Location[],
): ArticleHistoryPoint[] {
  const locationById = new Map(locations.map((l) => [l.id, l]));

  const sortedSessions = [...completedSessions]
    .filter((s) => s.status === "COMPLETED" && s.completedAt !== null)
    .sort((a, b) => (a.completedAt as string).localeCompare(b.completedAt as string));

  const points: ArticleHistoryPoint[] = [];
  let previousCount: number | null = null;

  for (const session of sortedSessions) {
    const entriesForArticle = (entriesBySessionId.get(session.id) ?? []).filter(
      (entry) => entry.articleId === articleId,
    );
    if (!isArticleFullyCounted(entriesForArticle)) continue;

    const totalCount = entriesForArticle.reduce(
      (sum, entry) => sum + (entry.counted ? entry.quantity ?? 0 : 0),
      0,
    );
    const locationIds = new Set(
      entriesForArticle.filter((entry) => entry.locationId !== null).map((entry) => entry.locationId as string),
    );
    const locationNames = Array.from(locationIds)
      .map((id) => locationById.get(id)?.name ?? id)
      .sort((a, b) => a.localeCompare(b, "nl"));

    points.push({
      sessionId: session.id,
      date: session.completedAt as string,
      totalCount,
      difference: previousCount === null ? null : totalCount - previousCount,
      locationNames,
    });
    previousCount = totalCount;
  }

  return points;
}
