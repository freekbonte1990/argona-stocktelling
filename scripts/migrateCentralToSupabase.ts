import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CentralFileRow {
  kind: "master" | "history";
  office_id: string;
  payload: unknown;
  meta: Record<string, unknown>;
}

const OFFICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Leest alle `<kantoor>.json`-bestanden van één map en maakt er rijen voor `central_files` van. */
export async function readCentralFiles(dir: string, kind: "master" | "history"): Promise<CentralFileRow[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows: CentralFileRow[] = [];
  for (const fileName of names.sort()) {
    if (!fileName.endsWith(".json")) continue;
    const officeId = fileName.slice(0, -".json".length);
    if (!OFFICE_ID_PATTERN.test(officeId)) continue;
    const payload: unknown = JSON.parse(await readFile(join(dir, fileName), "utf8"));
    if (!isRecord(payload) || payload.officeId !== officeId) {
      throw new Error(`${join(dir, fileName)}: officeId in het bestand komt niet overeen met de bestandsnaam.`);
    }
    rows.push({ kind, office_id: officeId, payload, meta: buildMeta(kind, payload) });
  }
  return rows;
}

/** Kleine samenvatting die de kantorenlijst van api/central-master kan lezen zonder het hele bestand op te halen. */
export function buildMeta(kind: "master" | "history", payload: Record<string, unknown>): Record<string, unknown> {
  if (kind === "master") {
    const office = isRecord(payload.office) ? payload.office : {};
    return {
      name: typeof office.name === "string" ? office.name : null,
      revision: typeof payload.revision === "string" ? payload.revision : null,
      generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : null,
      articleCount: Array.isArray(payload.articles) ? payload.articles.length : 0,
    };
  }
  return {
    generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : null,
    entryCount: Array.isArray(payload.entries) ? payload.entries.length : 0,
  };
}

/** Upsert van de rijen via PostgREST met de service-sleutel (niet de publieke sleutel). */
export async function uploadCentralFiles(
  rows: CentralFileRow[],
  config: { url: string; serviceKey: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.url.replace(/\/+$/, "");
  for (const row of rows) {
    const response = await doFetch(`${base}/rest/v1/central_files?on_conflict=kind,office_id`, {
      method: "POST",
      headers: {
        apikey: config.serviceKey,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]),
    });
    if (!response.ok) {
      throw new Error(`${row.kind}/${row.office_id}: server gaf status ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  }
}
