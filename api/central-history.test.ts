import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "./central-history";

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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "secret-outside.json"), { force: true });
  process.env = { ...original };
});

describe("api/central-history — zonder authenticatie, alleen-lezen", () => {
  it("antwoordt zonder Authorization-header met de bestandsinhoud (geen code, token of login nodig)", async () => {
    const res = await GET(request("?officeId=damme"));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toMatchObject({ officeId: "damme" });
  });

  it("een meegestuurde Authorization-header wordt genegeerd (nooit 401/503)", async () => {
    expect((await GET(request("?officeId=damme", "willekeurig"))).status).toBe(200);
  });

  it("antwoorden zijn nooit cachebaar (private, no-store)", async () => {
    const res = await GET(request("?officeId=damme"));
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("alleen-lezen: elke schrijfmethode geeft 405", async () => {
    for (const handler of [POST, PUT, PATCH, DELETE]) expect(handler().status).toBe(405);
  });
});

describe("api/central-history — invoer en bestanden", () => {
  it("onbekend kantoor → 404", async () => {
    expect((await GET(request("?officeId=lokeren"))).status).toBe(404);
  });

  it.each(["../secret-outside", "..%2Fsecret-outside", "damme/../../x", "DAMME", "", "damme.json", "%00"])(
    "pad-/vormmisbruik %j wordt geweigerd (geen path traversal)",
    async (officeId) => {
      const res = await GET(request(`?officeId=${officeId}`));
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("secret");
    },
  );

  it("zonder officeId → 400", async () => {
    expect((await GET(request(""))).status).toBe(400);
  });
});
