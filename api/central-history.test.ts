import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./central-history";

const TOKEN = "test-token-0123456789abcdef";
const OTHER_TOKEN = "rotated-token-0123456789abcdef";
let dir: string;
const original = { ...process.env };

function request(path: string, token?: string, init: RequestInit = {}) {
  return new Request(`https://example.test/api/central-history${path}`, {
    ...init,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "central-history-"));
  writeFileSync(join(dir, "damme.json"), JSON.stringify({ schemaVersion: 1, officeId: "damme", entries: [] }));
  // Een gevoelig bestand BUITEN de data-map: mag nooit bereikbaar zijn.
  writeFileSync(join(dir, "..", "secret-outside.json"), "{\"secret\":true}");
  process.env.CENTRAL_HISTORY_DATA_DIR = dir;
  process.env.CENTRAL_HISTORY_TOKENS = `${TOKEN}, ${OTHER_TOKEN}`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "secret-outside.json"), { force: true });
  process.env = { ...original };
});

describe("api/central-history — toegangscontrole (security-blocker)", () => {
  it("zonder Authorization-header: 401, nooit data", async () => {
    const res = await GET(request("?officeId=damme"));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("schemaVersion");
  });

  it("met een foute code: 401", async () => {
    expect((await GET(request("?officeId=damme", "fout-fout-fout-fout-fout"))).status).toBe(401);
  });

  it("een bijna-juiste code (zelfde prefix) wordt geweigerd", async () => {
    expect((await GET(request("?officeId=damme", TOKEN.slice(0, -1)))).status).toBe(401);
    expect((await GET(request("?officeId=damme", `${TOKEN}x`))).status).toBe(401);
  });

  it("een niet-Bearer-schema wordt geweigerd", async () => {
    const req = new Request("https://example.test/api/central-history?officeId=damme", {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect((await GET(req)).status).toBe(401);
  });

  it("met een geldige code: 200 en de bestandsinhoud", async () => {
    const res = await GET(request("?officeId=damme", TOKEN));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toMatchObject({ officeId: "damme" });
  });

  it("ondersteunt rotatie: elke code uit CENTRAL_HISTORY_TOKENS werkt", async () => {
    expect((await GET(request("?officeId=damme", OTHER_TOKEN))).status).toBe(200);
  });

  it("FAALT GESLOTEN: zonder geconfigureerde CENTRAL_HISTORY_TOKENS is niets bereikbaar (503)", async () => {
    delete process.env.CENTRAL_HISTORY_TOKENS;
    expect((await GET(request("?officeId=damme", TOKEN))).status).toBe(503);
    expect((await GET(request("?officeId=damme"))).status).toBe(503);
  });

  it("te korte (zwakke) codes in de configuratie tellen niet mee", async () => {
    process.env.CENTRAL_HISTORY_TOKENS = "kort";
    expect((await GET(request("?officeId=damme", "kort"))).status).toBe(503);
  });

  it("antwoorden zijn nooit cachebaar (private, no-store)", async () => {
    for (const res of [await GET(request("?officeId=damme", TOKEN)), await GET(request("?officeId=damme"))]) {
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
    }
  });

  it("alleen-lezen: elke schrijfmethode geeft 405", async () => {
    for (const handler of [POST, PUT, PATCH, DELETE]) expect(handler().status).toBe(405);
  });
});

describe("api/central-history — invoer en bestanden", () => {
  it("onbekend kantoor → 404 (pas ná autorisatie)", async () => {
    expect((await GET(request("?officeId=lokeren", TOKEN))).status).toBe(404);
    expect((await GET(request("?officeId=lokeren"))).status).toBe(401);
  });

  it.each(["../secret-outside", "..%2Fsecret-outside", "damme/../../x", "DAMME", "", "damme.json", "%00"])(
    "pad-/vormmisbruik %j wordt geweigerd (geen path traversal)",
    async (officeId) => {
      const res = await GET(request(`?officeId=${officeId}`, TOKEN));
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("secret");
    },
  );

  it("zonder officeId → 400", async () => {
    expect((await GET(request("", TOKEN))).status).toBe(400);
  });
});
