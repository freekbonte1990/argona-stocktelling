import { buildSnapshotAndReviewFromHistory, sessionSnapshotName } from "../../domain/stockSnapshot";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";
import type { CountSession } from "../../domain/types";
import { generateSessionId } from "../../shared/ids";
import type { CountingRepository } from "../ports/CountingRepository";

/**
 * Gedeeld door `ImportService` (Excel-import) en `CentralHistorySyncService`
 * (centrale historiek): elke sessie uit `historyEntries` die lokaal NOG NIET
 * als echte CountSession bekend is, wordt gereconstrueerd als een
 * volwaardige, afgeronde sessie + `FinalizedSessionResult` — zodat ze
 * voortaan gewoon als "Vorige telling" verschijnt en in "Analyse"/
 * "Vergelijken" selecteerbaar is, exact zoals een sessie die wél op dit
 * toestel liep (zie domain/stockSnapshot.ts#buildSnapshotAndReviewFromHistory
 * voor de precisie-afweging die dit onvermijdelijk met zich meebrengt).
 *
 * Legacy periodes (`source: "LEGACY_IMPORT"`) hebben hun eigen, al bestaand
 * pad (ComparisonService) en worden hier bewust overgeslagen — nooit als
 * CountSession gemodelleerd.
 *
 * Identiteit/idempotentie: een regel draagt, indien de bron dat al
 * ondersteunt, haar ECHTE originele `CountSession.id` (`sourceSessionId`) —
 * die wordt HERGEBRUIKT als id van de gereconstrueerde sessie, zodat twee
 * toestellen die onafhankelijk dezelfde sessie importeren/synchroniseren
 * (of hetzelfde toestel dat dit herhaalt) altijd op exact dezelfde, stabiele
 * CountSession.id uitkomen — nooit enkel een heuristische match op
 * sessienaam/datum. Ontbreekt die kolom, dan valt dit terug op een vers
 * gegenereerd id, met de sessienaam als (zwakkere) dedup-sleutel. In beide
 * gevallen geldt: eenmaal lokaal bekend (op id ÓF op naam), wordt een sessie
 * nooit opnieuw aangemaakt.
 *
 * Bestaande sessies worden NOOIT gewijzigd of overschreven — dit is puur
 * additief.
 *
 * Geeft de nieuw aangemaakte sessies terug.
 */
export async function reconstructMissingSessionsFromHistory(
  repository: CountingRepository,
  officeId: string,
  historyEntries: StockHistoryEntry[],
  sourceFileName: string,
): Promise<CountSession[]> {
  const created: CountSession[] = [];
  if (historyEntries.length === 0) return created;

  const existingSessions = await repository.getSessionsForOffice(officeId);
  // Een id-match is altijd ondubbelzinnig (en moet ELKE bestaande sessie
  // blokkeren, ongeacht status — nooit twee CountSession-records met
  // hetzelfde id). De (zwakkere) naam-heuristiek is enkel zinvol tegen
  // reeds AFGERONDE sessies: een toevallig gelijknamige ACTIEVE sessie
  // (bv. een nieuwe telling die toevallig in dezelfde kalendermaand
  // gestart werd) mag de reconstructie van een echt andere, elders
  // afgeronde telling nooit stilzwijgend blokkeren.
  const knownSessionIds = new Set(existingSessions.map((s) => s.id));
  const knownSessionNames = new Set(
    existingSessions.filter((s) => s.status === "COMPLETED").map((s) => sessionSnapshotName(s)),
  );
  const currentArticles = await repository.getArticles(officeId);
  const articlesById = new Map(currentArticles.map((a) => [a.id, a]));

  const entriesBySessionName = new Map<string, StockHistoryEntry[]>();
  for (const entry of historyEntries) {
    if (entry.source === "LEGACY_IMPORT") continue;
    if (entry.sourceSessionId && knownSessionIds.has(entry.sourceSessionId)) continue;
    if (knownSessionNames.has(entry.sessionName)) continue;
    const list = entriesBySessionName.get(entry.sessionName) ?? [];
    list.push(entry);
    entriesBySessionName.set(entry.sessionName, list);
  }

  for (const sessionEntries of entriesBySessionName.values()) {
    const first = sessionEntries[0];
    // Stabiele identiteit (zie hierboven): hergebruik `sourceSessionId`
    // wanneer elke regel van deze sessie dezelfde draagt — defensief
    // terugvallen op een vers id zodra dat ontbreekt of, in theorie,
    // inconsistent is (zou nooit mogen gebeuren: alle regels van één
    // sessie komen altijd uit dezelfde `buildHistoryEntriesFromSnapshot`-
    // aanroep, dus altijd hetzelfde `sourceSessionId`).
    const stableSessionId = sessionEntries.every((e) => e.sourceSessionId === first.sourceSessionId)
      ? first.sourceSessionId
      : undefined;
    const sessionId = stableSessionId ?? generateSessionId();
    // Enkel de lokale kalenderdag is gekend (StockHistoryEntry.countDate)
    // — zelfde precedent als ComparisonService#legacySortKey: middernacht
    // UTC van die datum, zodat sorteer-/datumlogica die een volledige
    // ISO-timestamp verwacht (sessionSnapshotName, localeCompare-sortering)
    // correct blijft werken.
    const completedAt = `${first.countDate}T00:00:00.000Z`;
    const session: CountSession = {
      id: sessionId,
      officeId,
      type: first.sessionType,
      status: "COMPLETED",
      startedAt: completedAt,
      completedAt,
      sourceFileName,
      sourceBaseDate: null,
      articleIds: sessionEntries.filter((e) => e.status !== "OVERGENOMEN").map((e) => e.articleId),
    };
    const { snapshot, review } = buildSnapshotAndReviewFromHistory(session.id, sessionEntries, articlesById);
    await repository.finalizeSession({
      session,
      updatedArticles: [],
      historyEntries: [],
      review,
      snapshot,
    });
    created.push(session);
  }
  return created;
}
