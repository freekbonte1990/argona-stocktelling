/**
 * BEVEILIGD endpoint voor de centrale, read-only stockhistoriek (Vercel
 * Function, Node-runtime, Web-handler `GET`).
 *
 * WAAROM EEN FUNCTIE EN GEEN STATISCH BESTAND: alles in `public/`/`dist/` is
 * wereldwijd leesbaar op de productie-URL (er is geen Vercel Authentication/
 * wachtwoord op de deployment). Aantallen en kostprijzen mogen dus NOOIT als
 * statisch bestand online staan. De data staat daarom in `central-history-data/`
 * (BUITEN `public/`, dus nooit in de build-uitvoer) en wordt via `includeFiles`
 * (zie vercel.json) enkel in DEZE functie gebundeld. Een private GitHub-repo
 * alleen beschermt geen gedeployde assets — deze toegangscontrole wel.
 *
 * Toegang: `Authorization: Bearer <toegangscode>`. Geldige codes staan in de
 * Vercel-omgevingsvariabele `CENTRAL_HISTORY_TOKENS` (kommagescheiden, zodat
 * een code geroteerd kan worden zonder onderbreking). Zonder die variabele
 * faalt het endpoint GESLOTEN (503) — nooit open.
 *
 * Bewust ZELFSTANDIG (geen relatieve imports): Vercel bundelt dit bestand
 * apart en de rest van de app gebruikt extensieloze imports.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const OFFICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Gevoelige data: nooit door een CDN/proxy/browser-cache bewaren.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function configuredTokens(): string[] {
  return (process.env.CENTRAL_HISTORY_TOKENS ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length >= 16);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time vergelijking (via hashes van gelijke lengte) tegen alle geldige codes. */
function isAuthorized(authorizationHeader: string | null, tokens: string[]): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  if (!match) return false;
  const presented = digest(match[1].trim());
  let ok = false;
  for (const token of tokens) {
    if (timingSafeEqual(presented, digest(token))) ok = true;
  }
  return ok;
}

export async function GET(request: Request): Promise<Response> {
  const tokens = configuredTokens();
  if (tokens.length === 0) {
    return json(503, { error: "Centrale historiek is niet geconfigureerd." });
  }
  if (!isAuthorized(request.headers.get("authorization"), tokens)) {
    return json(401, { error: "Niet geautoriseerd." }, { "WWW-Authenticate": 'Bearer realm="central-history"' });
  }

  const officeId = new URL(request.url).searchParams.get("officeId") ?? "";
  // Strikte whitelist-vorm: voorkomt path traversal (`../`) naar andere bestanden.
  if (!OFFICE_ID_PATTERN.test(officeId)) {
    return json(400, { error: "Ongeldig kantoor." });
  }

  const dataDir = process.env.CENTRAL_HISTORY_DATA_DIR ?? join(process.cwd(), "central-history-data");
  let raw: string;
  try {
    raw = await readFile(join(dataDir, `${officeId}.json`), "utf8");
  } catch {
    return json(404, { error: "Geen centrale historiek voor dit kantoor." });
  }
  return new Response(raw, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
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
