import type { CountingRepository, SyncedDocChange, SyncStateRow } from "../ports/CountingRepository";
import type { RemoteChange, RemoteStore, SyncCollection } from "../ports/RemoteStore";
import { isTemporaryArticle } from "../../domain/centralMasterFile";
import {
  diffLocalDocs,
  docKey,
  hashDoc,
  toRemoteDoc,
  toTombstone,
  type LocalDoc,
} from "../../domain/remoteSync";

export interface RemoteSyncOptions {
  /**
   * Enkel tellingen die vanaf dit tijdstip (ISO) gestart zijn, worden gesynchroniseerd. Oudere, lokaal
   * gereconstrueerde of geïmporteerde tellingen (die uit de centrale historiek komen) blijven buiten de
   * synchronisatie, zodat er geen dubbels ontstaan.
   */
  syncFrom: string;
}

export type SyncStatusState = "disabled" | "idle" | "syncing" | "error";

export interface SyncStatus {
  state: SyncStatusState;
  /** Aantal lokale wijzigingen die nog niet op de server staan (na de laatste poging). */
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
}

const BATCH_MAX_DOCS = 200;
const BATCH_MAX_BYTES = 900_000;
/** Pull haalt licht overlappend op (idempotent toegepast), zodat gelijktijdig gecommitte schrijfacties niet gemist worden. */
const PULL_OVERLAP_MS = 10_000;

const cursorId = (officeId: string) => `${officeId}|cursor`;
const stateId = (officeId: string, key: string) => `${officeId}|${key}`;

/**
 * Houdt de lokale IndexedDB (local-first) en de centrale server-opslag gelijk.
 *
 *  - PUSH: vergelijkt de lokale documenten met de laatst gesynchroniseerde hashes en uploadt wat wijzigde
 *    (inclusief tombstones voor verwijderde records). Mislukt dat (offline), dan blijft alles gewoon lokaal
 *    staan en wordt het bij de volgende poging opnieuw geprobeerd — er gaat nooit iets verloren.
 *  - PULL: haalt wijzigingen van andere toestellen binnen. Een lokaal nog niet geüpload document wint altijd.
 *
 * Gooit nooit: fouten komen in `getStatus()` terecht.
 */
export class RemoteSyncService {
  private status: SyncStatus;
  private listeners = new Set<(status: SyncStatus) => void>();
  private running: Promise<SyncStatus> | null = null;
  private rerun = false;

  private readonly repository: CountingRepository;
  private readonly remote: RemoteStore | null;
  private readonly options: RemoteSyncOptions;

  constructor(repository: CountingRepository, remote: RemoteStore | null, options: RemoteSyncOptions) {
    this.repository = repository;
    this.remote = remote;
    this.options = options;
    this.status = { state: remote ? "idle" : "disabled", pending: 0, lastSyncedAt: null, error: null };
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  /** Synchroniseert alle lokale kantoren (eerst binnenhalen, dan uploaden). Gelijktijdige aanroepen worden gebundeld. */
  syncNow(): Promise<SyncStatus> {
    if (!this.remote) return Promise.resolve(this.status);
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          await this.runOnce();
        } while (this.rerun);
      } finally {
        this.running = null;
      }
      return this.status;
    })();
    return this.running;
  }

  private async runOnce(): Promise<void> {
    this.setStatus({ state: "syncing" });
    let pending = 0;
    let firstError: string | null = null;
    try {
      const offices = await this.repository.getAllOffices();
      for (const office of offices) {
        try {
          await this.pull(office.id);
        } catch (err) {
          firstError ??= errorMessage(err);
        }
        try {
          pending += await this.push(office.id);
        } catch (err) {
          firstError ??= errorMessage(err);
          pending += await this.countPending(office.id).catch(() => 0);
        }
      }
    } catch (err) {
      firstError ??= errorMessage(err);
    }
    if (firstError) {
      this.setStatus({ state: "error", error: firstError, pending });
    } else {
      this.setStatus({ state: "idle", error: null, pending, lastSyncedAt: new Date().toISOString() });
    }
  }

  /** Aantal lokale wijzigingen dat nog niet op de server staat (zonder iets te versturen). */
  async countPending(officeId: string): Promise<number> {
    const { upserts, deletions } = await this.diff(officeId);
    return upserts.length + deletions.length;
  }

  // ---------------------------------------------------------------- lokale documenten

  private async collectLocalDocs(officeId: string): Promise<LocalDoc[]> {
    const docs: LocalDoc[] = [];
    const sessions = (await this.repository.getSessionsForOffice(officeId)).filter(
      (s) => !s.id.startsWith("central-") && s.startedAt >= this.options.syncFrom,
    );
    const finalizedSessionNames = new Set<string>();
    let hasFinalized = false;
    for (const session of sessions) {
      docs.push({ collection: "session", id: session.id, data: session });
      for (const entry of await this.repository.getCountEntries(session.id)) {
        docs.push({ collection: "entry", id: entry.id, data: entry });
      }
      for (const status of await this.repository.getLocationSessionStatuses(session.id)) {
        docs.push({ collection: "locStatus", id: status.id, data: status });
      }
      const finalized = await this.repository.getFinalizedSessionResult(session.id);
      if (finalized) {
        hasFinalized = true;
        finalizedSessionNames.add(finalized.snapshot.sessionName);
        docs.push({ collection: "finalized", id: session.id, data: finalized });
      }
    }
    if (finalizedSessionNames.size > 0) {
      for (const entry of await this.repository.getStockHistoryEntries(officeId)) {
        if (finalizedSessionNames.has(entry.sessionName)) {
          docs.push({
            collection: "history",
            id: `${officeId}:${entry.sessionName}:${entry.articleId}`,
            data: { ...entry, officeId, id: `${officeId}:${entry.sessionName}:${entry.articleId}` },
          });
        }
      }
    }
    for (const assignment of await this.repository.getArticleLocationAssignments(officeId)) {
      docs.push({ collection: "assignment", id: assignment.id, data: assignment });
    }
    const articles = await this.repository.getArticles(officeId);
    for (const article of articles) {
      if (isTemporaryArticle(article)) docs.push({ collection: "article", id: article.id, data: article });
    }
    if (hasFinalized) {
      docs.push({ collection: "prev", id: officeId, data: buildPrevMap(articles) });
    }
    return docs;
  }

  private async loadStates(officeId: string): Promise<Map<string, string>> {
    const rows = await this.repository.getSyncStates(officeId);
    const prefix = `${officeId}|`;
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.id === cursorId(officeId)) continue;
      map.set(row.id.slice(prefix.length), row.hash);
    }
    return map;
  }

  private async diff(officeId: string) {
    const local = await this.collectLocalDocs(officeId);
    const states = await this.loadStates(officeId);
    return { local, states, ...diffLocalDocs(local, states) };
  }

  // ---------------------------------------------------------------- push

  private async push(officeId: string): Promise<number> {
    const remote = this.remote!;
    const { upserts, deletions } = await this.diff(officeId);
    const items = [
      ...upserts.map((d) => ({ remote: toRemoteDoc(officeId, d), hash: hashDoc(d.data) as string | null })),
      ...deletions.map((d) => ({ remote: toTombstone(officeId, d), hash: null as string | null })),
    ];
    let remaining = items.length;
    let index = 0;
    while (index < items.length) {
      const batch: typeof items = [];
      let bytes = 0;
      while (index < items.length && batch.length < BATCH_MAX_DOCS) {
        const size = JSON.stringify(items[index].remote).length;
        if (batch.length > 0 && bytes + size > BATCH_MAX_BYTES) break;
        batch.push(items[index]);
        bytes += size;
        index += 1;
      }
      await remote.upsert(batch.map((b) => b.remote));
      const saved: SyncStateRow[] = [];
      const removed: string[] = [];
      for (const item of batch) {
        const id = stateId(officeId, docKey(item.remote.collection, item.remote.id));
        if (item.hash === null) removed.push(id);
        else saved.push({ id, officeId, hash: item.hash });
      }
      await this.repository.saveSyncStates(saved);
      await this.repository.deleteSyncStates(removed);
      remaining -= batch.length;
      this.setStatus({ pending: remaining });
    }
    return 0;
  }

  // ---------------------------------------------------------------- pull

  private async pull(officeId: string): Promise<void> {
    const remote = this.remote!;
    const cursorRows = (await this.repository.getSyncStates(officeId)).filter((r) => r.id === cursorId(officeId));
    const cursor = cursorRows[0]?.hash ?? null;
    const since = cursor ? new Date(new Date(cursor).getTime() - PULL_OVERLAP_MS).toISOString() : null;
    const changes = await remote.fetchChanges(officeId, since);
    if (changes.length === 0) return;

    const local = await this.collectLocalDocs(officeId);
    const states = await this.loadStates(officeId);
    const localHash = new Map(local.map((d) => [docKey(d.collection, d.id), hashDoc(d.data)]));

    const toApply: SyncedDocChange[] = [];
    const newStates: SyncStateRow[] = [];
    const removedStates: string[] = [];
    let touchedPrev = false;
    for (const change of changes) {
      const key = docKey(change.collection, change.id);
      const state = states.get(key);
      const mine = localHash.get(key);
      // Lokale, nog niet geüploade wijziging wint (state bestaat maar wijkt af van de lokale hash).
      if (state !== undefined && mine !== undefined && mine !== state) continue;
      if (change.deleted) {
        if (mine !== undefined || state !== undefined) {
          toApply.push({ collection: change.collection, id: change.id, deleted: true, data: null });
          removedStates.push(stateId(officeId, key));
        }
        continue;
      }
      // Lokaal verwijderd en die verwijdering is nog niet doorgegeven: niet terugzetten vanaf de server.
      if (state !== undefined && mine === undefined) continue;
      const remoteHash = hashDoc(change.data);
      if (state === remoteHash && mine === remoteHash) continue; // al gelijk
      toApply.push({ collection: change.collection, id: change.id, deleted: false, data: change.data });
      if (change.collection === "prev") touchedPrev = true;
      else newStates.push({ id: stateId(officeId, key), officeId, hash: remoteHash });
    }
    if (toApply.length > 0) await this.repository.applySyncedDocs(officeId, toApply);
    if (touchedPrev) {
      // De "vorige telling"-map wordt lokaal toegepast op de eigen artikelen; de baseline is wat er nu lokaal staat.
      const articles = await this.repository.getArticles(officeId);
      newStates.push({
        id: stateId(officeId, docKey("prev", officeId)),
        officeId,
        hash: hashDoc(buildPrevMap(articles)),
      });
    }
    await this.repository.saveSyncStates(newStates);
    await this.repository.deleteSyncStates(removedStates);
    await this.repository.saveSyncStates([{ id: cursorId(officeId), officeId, hash: latestUpdatedAt(changes) }]);
  }
}

function buildPrevMap(articles: Array<{ id: string; previousCount: number | null }>): Record<string, number | null> {
  const map: Record<string, number | null> = {};
  for (const a of articles) map[a.id] = a.previousCount;
  return map;
}

function latestUpdatedAt(changes: RemoteChange[]): string {
  return changes.reduce((max, c) => (c.updatedAt > max ? c.updatedAt : max), changes[0].updatedAt);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Onbekende synchronisatiefout";
}

export type { SyncCollection };
