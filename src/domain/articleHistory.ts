import { isArticleFullyCounted } from "./progress";
import type { ArticleSnapshotStatus, StockHistoryEntry } from "./stockSnapshot";
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

/**
 * Eén punt van de SAMENGEVOEGDE historiek (lokaal + geïmporteerd, rollend
 * stockarchief): dezelfde vorm als `ArticleHistoryPoint`, uitgebreid met de
 * tellingnaam en status telling — nodig zodra beide bronnen door elkaar
 * kunnen lopen (spec: "een nieuw toestel moet onmiddellijk historische
 * grafieken kunnen tonen na import, zonder lokale CountSessions").
 */
export interface MergedArticleHistoryPoint {
  sessionName: string;
  date: string;
  totalCount: number | null;
  difference: number | null;
  locationNames: string[];
  /** Lokale punten (uit `buildArticleHistory`) zijn per definitie altijd fysiek geteld deze sessie. */
  status: ArticleSnapshotStatus;
}

/**
 * Voegt de lokale historiek (dit toestel, uit CountSession/CountEntry) samen
 * met geïmporteerde `StockHistoryEntry`-regels (rollend Excelarchief) voor
 * ÉÉN artikel, zodat de grafiek/tabel op `ArticleDetailPage` beide bronnen
 * naadloos toont — ook wanneer dit toestel geen enkele lokale CountSession
 * kent (spec: "onmiddellijk historische grafieken tonen na import").
 *
 * Dedupliceert op tellingnaam (`localSessionNames` koppelt elke lokale
 * `sessionId` aan diezelfde naamgevingsconventie als het geëxporteerde
 * archief, zie `stockSnapshot.ts#sessionSnapshotName`) — bij een conflict
 * wint het LOKALE punt (preciezer: exacte locatienamen uit echte entries).
 * Na het samenvoegen wordt `difference` opnieuw berekend t.o.v. het
 * chronologisch voorgaande punt IN DE SAMENGEVOEGDE reeks — anders zou een
 * onafhankelijk berekend verschil van elke bron na het mergen onjuist zijn
 * (spec: "vermijd dat meerdere OVERGENOMEN snapshots de betekenis
 * vervormen").
 */
export function mergeArticleHistory(
  articleId: string,
  localPoints: ArticleHistoryPoint[],
  localSessionNames: Map<string, string>,
  importedEntries: StockHistoryEntry[],
): MergedArticleHistoryPoint[] {
  const byName = new Map<string, MergedArticleHistoryPoint>();

  for (const point of localPoints) {
    const sessionName = localSessionNames.get(point.sessionId) ?? point.sessionId;
    byName.set(sessionName, {
      sessionName,
      date: point.date,
      totalCount: point.totalCount,
      difference: null, // wordt hieronder herberekend over de samengevoegde reeks
      locationNames: point.locationNames,
      status: "GETELD",
    });
  }

  for (const entry of importedEntries) {
    if (entry.articleId !== articleId) continue;
    if (byName.has(entry.sessionName)) continue; // lokaal punt wint bij een conflict
    byName.set(entry.sessionName, {
      sessionName: entry.sessionName,
      date: entry.countDate,
      totalCount: entry.totalCount,
      difference: null,
      locationNames: entry.locationNames,
      status: entry.status,
    });
  }

  const sorted = Array.from(byName.values()).sort((a, b) => a.date.localeCompare(b.date));

  let previousCount: number | null = null;
  for (const point of sorted) {
    point.difference =
      previousCount === null || point.totalCount === null ? null : point.totalCount - previousCount;
    if (point.totalCount !== null) previousCount = point.totalCount;
  }

  return sorted;
}
