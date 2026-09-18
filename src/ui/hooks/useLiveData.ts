import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../adapters/storage/db";

/**
 * Reactieve (live) lees-hooks bovenop IndexedDB, gebruikt door UI-schermen
 * voor autosave/herstel: elke wijziging in de database (bv. een opgeslagen
 * CountEntry) laat de betrokken schermen automatisch herrenderen, zonder dat
 * er een expliciete "Save"-knop of handmatige refresh nodig is (spec §11).
 *
 * AANNAME: dit koppelt de UI-laag rechtstreeks aan Dexie voor "live" reads.
 * Schrijfacties en business-regels lopen wel via CountingRepository/services
 * (application/container.ts) — enkel deze reactieve read-hooks kennen Dexie
 * rechtstreeks. Een latere eBuddy-opslagadapter heeft een eigen manier nodig
 * om "live" te blijven (bv. polling); dat is bewust buiten scope van v0.1 en
 * blijft beperkt tot deze ene file. Zie docs/ARCHITECTURE.md.
 */

export function useAllOffices() {
  return useLiveQuery(() => db.offices.toArray(), [], []);
}

export function useOffice(officeId: string | undefined) {
  return useLiveQuery(() => (officeId ? db.offices.get(officeId) : undefined), [officeId]);
}

export function useArticles(officeId: string | undefined) {
  return useLiveQuery(
    () => (officeId ? db.articles.where("officeId").equals(officeId).toArray() : []),
    [officeId],
    [],
  );
}

export function useActiveSession(officeId: string | undefined) {
  return useLiveQuery(
    () =>
      officeId
        ? db.sessions
            .where("officeId")
            .equals(officeId)
            .and((s) => s.status === "ACTIVE")
            .first()
        : undefined,
    [officeId],
  );
}

export function useSession(sessionId: string | undefined) {
  return useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId]);
}

export function useCountEntries(sessionId: string | undefined) {
  return useLiveQuery(
    () => (sessionId ? db.countEntries.where("sessionId").equals(sessionId).toArray() : []),
    [sessionId],
    [],
  );
}

export function useAssignments(officeId: string | undefined) {
  return useLiveQuery(
    () => (officeId ? db.assignments.where("officeId").equals(officeId).toArray() : []),
    [officeId],
    [],
  );
}

/** Welk kantoor laatst geselecteerd was (multi-kantoor — overleeft een refresh). */
export function useSelectedOfficeId() {
  return useLiveQuery(async () => (await db.appState.get("singleton"))?.selectedOfficeId, []);
}

/** Alle sessies van een kantoor (actief + afgerond), nieuwste eerst — voor "vorige tellingen" op HomePage. */
export function useSessionsForOffice(officeId: string | undefined) {
  return useLiveQuery(
    () =>
      officeId
        ? db.sessions
            .where("officeId")
            .equals(officeId)
            .toArray()
            .then((sessions) => sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt)))
        : [],
    [officeId],
    [],
  );
}
