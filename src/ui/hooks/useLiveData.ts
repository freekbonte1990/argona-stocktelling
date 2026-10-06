import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../adapters/storage/db";
import { buildArticleHistory, mergeArticleHistory } from "../../domain/articleHistory";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
import { listLegacySnapshotItems } from "../../domain/legacySnapshotView";
import type { CountEntry } from "../../domain/types";

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

/**
 * Sprint 3.2.1-architectuurfix: ALLE artikelen, over alle kantoren heen.
 * Nodig voor de globale Productgamma-beheer-UI (SettingsPage): "aantal
 * toegewezen artikelen"/"kan verwijderd worden" voor een bedrijfsbrede
 * categorie moet over alle kantoren gecontroleerd worden, niet enkel het
 * momenteel geselecteerde kantoor.
 */
export function useAllArticles() {
  return useLiveQuery(() => db.articles.toArray(), [], []);
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

/**
 * Sprint 3.2 — "Productgamma's": reactieve lijst, ONGESORTEERD (sorteer met
 * `allProductCategoriesInOrder`/`activeProductCategoriesInOrder` uit
 * `domain/productCategory.ts` op het gebruikspunt). Puur een reactieve READ —
 * de eenmalige, per-kantoor migratie (bootstrap uit bestaande `productGroup`-
 * waarden, spec §4) loopt via `productCategoryService.listCategories`, dat
 * elk scherm dat categorieën nodig heeft één keer (in een effect) aanroept.
 *
 * Sprint 3.2.1-architectuurfix: `ProductCategory` is nu bedrijfsbreed/globaal
 * (geen `officeId` meer, zie domain/types.ts) — deze hook leest daarom ALTIJD
 * de volledige, gedeelde lijst, ongeacht welk kantoor actief is. Geen
 * parameter meer nodig.
 */
export function useProductCategories() {
  return useLiveQuery(() => db.productCategories.toArray(), [], []);
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

/** Locatiestatussen (OPEN/COMPLETED) van één sessie (spec v0.2.1 §4). */
export function useLocationStatuses(sessionId: string | undefined) {
  return useLiveQuery(
    () => (sessionId ? db.locationSessionStatuses.where("sessionId").equals(sessionId).toArray() : []),
    [sessionId],
    [],
  );
}

/**
 * Historiek van één artikel over alle afgeronde sessies van een kantoor
 * heen (spec v0.2.1 §7-8). Dit is de enige plek buiten de repository die
 * over meerdere sessies heen leest — bewust hier gehouden (zie de
 * architectuurnoot bovenaan dit bestand) in plaats van een nieuwe
 * CountingRepository-methode, om de repository-interface niet te laten
 * groeien voor iets wat puur een reactieve UI-berekening is.
 */
export function useArticleHistory(officeId: string | undefined, articleId: string | undefined) {
  return useLiveQuery(
    async () => {
      if (!officeId || !articleId) return [];
      const [office, sessions] = await Promise.all([
        db.offices.get(officeId),
        db.sessions
          .where("officeId")
          .equals(officeId)
          .and((s) => s.status === "COMPLETED")
          .toArray(),
      ]);
      const entriesBySessionId = new Map<string, CountEntry[]>();
      // Sprint 3.1 §7: bevroren kostprijs per sessie voor dit artikel, uit
      // `FinalizedSessionResult.snapshot` — nooit de levende `Article.costPrice`.
      // Een sessie zonder bevroren resultaat (legacy/pre-hardening) levert hier
      // bewust `null` op ("onbekend"), zie `domain/articleHistory.ts`.
      const costPriceBySessionId = new Map<string, number | null>();
      await Promise.all(
        sessions.map(async (session) => {
          const [entries, finalizedResult] = await Promise.all([
            db.countEntries
              .where("sessionId")
              .equals(session.id)
              .and((e) => e.articleId === articleId)
              .toArray(),
            db.finalizedSessionResults.get(session.id),
          ]);
          entriesBySessionId.set(session.id, entries);
          const articleSnapshot = finalizedResult?.snapshot.articles.find((a) => a.articleId === articleId);
          costPriceBySessionId.set(session.id, articleSnapshot?.costPrice ?? null);
        }),
      );
      const localHistory = buildArticleHistory(
        articleId,
        sessions,
        entriesBySessionId,
        office?.locations ?? [],
        costPriceBySessionId,
      );

      // Rollend stockarchief: voeg geïmporteerde HISTORIE-regels samen met de
      // lokale historiek — zo toont een nieuw toestel, zonder lokale
      // CountSessions, meteen de volledige, geïmporteerde grafiek/tabel
      // (spec). `localSessionNames` koppelt elke lokale sessie aan dezelfde
      // naamgevingsconventie als het geëxporteerde archief, zodat
      // `mergeArticleHistory` correct kan dedupliceren.
      const localSessionNames = new Map(sessions.map((s) => [s.id, sessionSnapshotName(s)]));
      const importedEntries = await db.stockHistoryEntries
        .where("officeId")
        .equals(officeId)
        .and((e) => e.articleId === articleId)
        .toArray();

      return mergeArticleHistory(articleId, localHistory, localSessionNames, importedEntries);
    },
    [officeId, articleId],
    [],
  );
}

/**
 * Centrale read-only historiek: status van de laatste sync voor dit kantoor
 * (`undefined` zolang er nog nooit een poging gebeurde, of nog aan het laden).
 */
export function useCentralHistoryStatus(officeId: string | undefined) {
  return useLiveQuery(() => (officeId ? db.centralHistoryStatus.get(officeId) : undefined), [officeId]);
}

/**
 * Centrale masterdata: status per kantoor (`undefined` zolang er nog niets is
 * toegepast, of nog aan het laden). `isCentrallyManaged(status)` bepaalt de
 * read-only weergave van master-velden.
 */
export function useCentralMasterStatus(officeId: string | undefined) {
  return useLiveQuery(() => (officeId ? db.centralMasterStatus.get(officeId) : undefined), [officeId]);
}

/** Legacy "Historische snapshots" van een kantoor (nieuwste eerst) — presentatie-items, geen sessies. */
export function useLegacySnapshots(officeId: string | undefined) {
  return useLiveQuery(
    () =>
      officeId
        ? db.stockHistoryEntries
            .where("officeId")
            .equals(officeId)
            .filter((entry) => entry.source === "LEGACY_IMPORT")
            .toArray()
            .then((entries) => listLegacySnapshotItems(entries))
        : [],
    [officeId],
    [],
  );
}
