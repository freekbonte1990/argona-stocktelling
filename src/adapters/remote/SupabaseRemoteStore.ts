import type { RemoteChange, RemoteDoc, RemoteStore, SyncCollection } from "../../application/ports/RemoteStore";

export interface SupabaseRemoteStoreConfig {
  /** Bv. https://abcdxyz.supabase.co (zonder slash op het einde). */
  url: string;
  /** Publieke (anon) sleutel. */
  anonKey: string;
  fetchImpl?: typeof fetch;
  /** Time-out per verzoek in ms. */
  timeoutMs?: number;
}

interface SyncDocRow {
  collection: SyncCollection;
  id: string;
  office_id: string;
  data: unknown | null;
  deleted: boolean;
  updated_at: string;
}

const PAGE_SIZE = 1000;

/**
 * Supabase-adapter (PostgREST via fetch, geen extra bibliotheek) voor de documenttabel `sync_docs`
 * (zie supabase/schema.sql). Gooit bij elke fout; `RemoteSyncService` vangt dat op en probeert later opnieuw.
 */
export class SupabaseRemoteStore implements RemoteStore {
  private readonly url: string;
  private readonly anonKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: SupabaseRemoteStoreConfig) {
    this.url = config.url.replace(/\/+$/, "");
    this.anonKey = config.anonKey;
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.anonKey, ...extra };
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Server gaf status ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async upsert(docs: RemoteDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const rows = docs.map((d) => ({
      collection: d.collection,
      id: d.id,
      office_id: d.officeId,
      data: d.data,
      deleted: d.deleted,
    }));
    await this.request(`${this.url}/rest/v1/sync_docs?on_conflict=collection,id`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(rows),
    });
  }

  async fetchChanges(officeId: string, since: string | null): Promise<RemoteChange[]> {
    const all: RemoteChange[] = [];
    let cursor = since;
    // Pagineer op updated_at; dezelfde timestamp over een paginagrens is onwaarschijnlijk (clock_timestamp per rij)
    // en wordt anders bij de volgende pull (met overlap) alsnog opgehaald.
    for (;;) {
      const params = new URLSearchParams();
      params.set("office_id", `eq.${officeId}`);
      if (cursor) params.set("updated_at", `gt.${cursor}`);
      params.set("order", "updated_at.asc");
      params.set("limit", String(PAGE_SIZE));
      const response = await this.request(`${this.url}/rest/v1/sync_docs?${params.toString()}`, {
        method: "GET",
        headers: this.headers(),
      });
      const rows = (await response.json()) as SyncDocRow[];
      for (const row of rows) {
        all.push({
          collection: row.collection,
          id: row.id,
          officeId: row.office_id,
          data: row.data,
          deleted: row.deleted,
          updatedAt: row.updated_at,
        });
      }
      if (rows.length < PAGE_SIZE) break;
      cursor = rows[rows.length - 1].updated_at;
    }
    return all;
  }
}

/** Leest de configuratie uit de Vite-omgeving; `null` wanneer niet ingesteld (synchronisatie uit). */
export function createSupabaseRemoteStoreFromEnv(env: Record<string, string | undefined>): SupabaseRemoteStore | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return new SupabaseRemoteStore({ url, anonKey });
}
