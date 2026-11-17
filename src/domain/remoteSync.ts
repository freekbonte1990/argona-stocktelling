import type { RemoteDoc, SyncCollection } from "../application/ports/RemoteStore";

/** Sleutel van een document binnen één kantoor. */
export function docKey(collection: SyncCollection, id: string): string {
  return `${collection}|${id}`;
}

/** Deterministische JSON (gesorteerde sleutels): Postgres-jsonb bewaart sleutelvolgorde niet. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

/** Snelle, niet-cryptografische hash (cyrb53) van de canonieke JSON — enkel voor wijzigingsdetectie. */
export function hashDoc(data: unknown): string {
  const str = canonicalStringify(data);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}${str.length.toString(16)}`;
}

export interface LocalDoc {
  collection: SyncCollection;
  id: string;
  data: unknown;
}

export interface SyncDiff {
  upserts: LocalDoc[];
  /** Sleutels die ooit gesynchroniseerd werden maar lokaal niet meer bestaan → tombstone. */
  deletions: Array<{ collection: SyncCollection; id: string }>;
}

/**
 * Vergelijkt de lokale documenten met de laatst gesynchroniseerde hashes.
 * Een document dat nog nooit gesynchroniseerd werd, of waarvan de hash wijzigde, wordt geüpload.
 */
export function diffLocalDocs(local: LocalDoc[], states: ReadonlyMap<string, string>): SyncDiff {
  const upserts: LocalDoc[] = [];
  const seen = new Set<string>();
  for (const doc of local) {
    const key = docKey(doc.collection, doc.id);
    seen.add(key);
    if (states.get(key) !== hashDoc(doc.data)) upserts.push(doc);
  }
  const deletions: SyncDiff["deletions"] = [];
  for (const key of states.keys()) {
    if (seen.has(key)) continue;
    const sep = key.indexOf("|");
    deletions.push({ collection: key.slice(0, sep) as SyncCollection, id: key.slice(sep + 1) });
  }
  return { upserts, deletions };
}

export function toRemoteDoc(officeId: string, doc: LocalDoc): RemoteDoc {
  return { collection: doc.collection, id: doc.id, officeId, data: doc.data, deleted: false };
}

export function toTombstone(officeId: string, d: { collection: SyncCollection; id: string }): RemoteDoc {
  return { collection: d.collection, id: d.id, officeId, data: null, deleted: true };
}
