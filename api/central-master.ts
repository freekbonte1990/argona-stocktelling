/**
 * Endpoint voor de centrale, read-only MASTERDATA (kantoor, locaties,
 * productgamma's, artikelen met kostprijzen, koppelingen) — Vercel Function,
 * Node-runtime, Web-handler `GET`. Zusje van `api/central-history.ts`.
 *
 *   GET /api/central-master                    → kantorenlijst (id, naam, revision, …)
 *   GET /api/central-master?officeId=lokeren   → volledige master van dat kantoor
 *        met `If-None-Match: "<revision>"` → 304 wanneer niets veranderd is
 *
 * ZONDER AUTHENTICATIE (bewuste keuze: geen toegangscode, login of token in de
 * app — de eBuddy-integratie brengt de echte toegangscontrole). Dit endpoint is
 * dus voor IEDEREEN met de URL leesbaar, inclusief kostprijzen. Het blijft wel een
 * functie (geen statisch bestand): de data staat in `central-master-data/` (BUITEN
 * `public/`), wordt via `includeFiles` (zie vercel.json) enkel in DEZE functie
 * gebundeld, en het endpoint is alleen-lezen met een strikte kantoor-whitelist.
 *
 * Bewust ZELFSTANDIG (geen relatieve imports): Vercel bundelt dit bestand apart.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const OFFICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCHEMA_VERSION = 1;

const NO_STORE = "private, no-store, max-age=0";

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Nooit door een CDN/proxy/browser-cache bewaren: een nieuwe publicatie moet meteen gelden.
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function dataDirectory(): string {
  return process.env.CENTRAL_MASTER_DATA_DIR ?? join(process.cwd(), "central-master-data");
}

function stripEtag(value: string): string {
  return value.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function officeIndex(): Promise<Response> {
  const dir = dataDirectory();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }
  const offices: Array<{ id: string; name: string; revision: string; generatedAt: string; articleCount: number }> = [];
  for (const fileName of names.sort()) {
    if (!fileName.endsWith(".json")) continue;
    const id = fileName.slice(0, -".json".length);
    if (!OFFICE_ID_PATTERN.test(id)) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, fileName), "utf8"));
      if (!isRecord(parsed) || parsed.officeId !== id || !isRecord(parsed.office)) continue;
      const { revision, generatedAt, articles } = parsed;
      if (typeof revision !== "string" || typeof generatedAt !== "string" || !Array.isArray(articles)) continue;
      const name = parsed.office.name;
      if (typeof name !== "string" || name === "") continue;
      offices.push({ id, name, revision, generatedAt, articleCount: articles.length });
    } catch {
      // Een kapot bestand verbergt de andere kantoren niet.
    }
  }
  offices.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  return json(200, { schemaVersion: SCHEMA_VERSION, offices });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!url.searchParams.has("officeId")) {
    return officeIndex();
  }

  const officeId = url.searchParams.get("officeId") ?? "";
  // Strikte whitelist-vorm: voorkomt path traversal (`../`) naar andere bestanden.
  if (!OFFICE_ID_PATTERN.test(officeId)) {
    return json(400, { error: "Ongeldig kantoor." });
  }

  let raw: string;
  try {
    raw = await readFile(join(dataDirectory(), `${officeId}.json`), "utf8");
  } catch {
    return json(404, { error: "Geen centrale masterdata voor dit kantoor." });
  }

  let revision = "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.revision === "string") revision = parsed.revision;
  } catch {
    return json(500, { error: "Centrale masterdata is beschadigd." });
  }
  const etagHeaders: Record<string, string> = revision ? { ETag: `"${revision}"` } : {};

  const ifNoneMatch = request.headers.get("if-none-match");
  if (revision && ifNoneMatch && ifNoneMatch.split(",").some((candidate) => stripEtag(candidate) === revision)) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": NO_STORE, "X-Content-Type-Options": "nosniff", ...etagHeaders },
    });
  }

  return new Response(raw, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      ...etagHeaders,
    },
  });
}

/** Alle andere methodes zijn niet toegestaan: het endpoint is alleen-lezen. */
export function POST(): Response {
  return json(405, { error: "Alleen-lezen." }, { Allow: "GET" });
}
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
