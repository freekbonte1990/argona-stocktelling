/**
 * Endpoint voor de centrale, read-only stockhistoriek (Vercel Function,
 * Node-runtime, Web-handler `GET`).
 *
 * ZONDER AUTHENTICATIE (bewuste keuze: geen toegangscode, login of token in de
 * app — de eBuddy-integratie brengt de echte toegangscontrole). Dit endpoint is
 * dus voor IEDEREEN met de URL leesbaar. Het blijft wel een functie (geen
 * statisch bestand): de data staat in `central-history-data/` (BUITEN `public/`,
 * dus nooit in de build-uitvoer), wordt via `includeFiles` (zie vercel.json) enkel
 * in DEZE functie gebundeld, en het endpoint is alleen-lezen met een strikte
 * kantoor-whitelist.
 *
 * Bewust ZELFSTANDIG (geen relatieve imports): Vercel bundelt dit bestand
 * apart en de rest van de app gebruikt extensieloze imports.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const OFFICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Nooit door een CDN/proxy/browser-cache bewaren: een nieuwe publicatie moet meteen gelden.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
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
