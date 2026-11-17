/**
 * Port voor de centrale (server-)opslag van tellingen. De app blijft local-first (IndexedDB), maar elk
 * record wordt naar deze store gesynchroniseerd, zodat een telling nooit alleen op één toestel staat.
 * Vandaag geïmplementeerd door `SupabaseRemoteStore`; later vervangbaar (bv. door de eBuddy-API).
 */
export type SyncCollection =
  | "session"
  | "entry"
  | "locStatus"
  | "finalized"
  | "history"
  | "assignment"
  | "article"
  | "prev";

export interface RemoteDoc {
  collection: SyncCollection;
  id: string;
  officeId: string;
  /** `null` bij een tombstone (verwijderd). */
  data: unknown | null;
  deleted: boolean;
}

export interface RemoteChange extends RemoteDoc {
  /** Door de server gezet (ISO met microseconden), gebruikt als cursor. */
  updatedAt: string;
}

export interface RemoteStore {
  /** Schrijft (upsert) documenten. Gooit bij een fout (de aanroeper probeert later opnieuw). */
  upsert(docs: RemoteDoc[]): Promise<void>;
  /** Alle wijzigingen van een kantoor sinds `since` (exclusief), oudste eerst. `since = null` → alles. */
  fetchChanges(officeId: string, since: string | null): Promise<RemoteChange[]>;
}
