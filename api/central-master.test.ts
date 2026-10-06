import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMaster } from "../src/application/services/centralMasterTestUtils";
import { DELETE, GET, PATCH, POST, PUT } from "./central-master";

let dir: string;
const original = { ...process.env };

function request(path: string, extra: string | Record<string, string> = {}) {
  const headers = typeof extra === "string" ? { Authorization: `Bearer ${extra}` } : extra;
  return new Request(`https://example.test/api/central-master${path}`, { headers });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "central-master-"));
  writeFileSync(join(dir, "damme.json"), JSON.stringify(makeMaster()));
  writeFileSync(join(dir, "lokeren.json"), JSON.stringify(makeMaster({ officeId: "lokeren", office: { name: "Lokeren", baseDate: null }, revision: "rev-lok-1" })));
  writeFileSync(join(dir, "kapot.json"), "{niet-json");
  writeFileSync(join(dir, "README.md"), "# geen kantoor");
  writeFileSync(join(dir, "..", "secret-outside.json"), '{"secret":true}');
  process.env.CENTRAL_MASTER_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "secret-outside.json"), { force: true });
  process.env = { ...original };
});

describe("api/central-master — zonder authenticatie, alleen-lezen", () => {
  it("antwoordt zonder Authorization-header: 200 met de master (ETag = revision)", async () => {
    const res = await GET(request("?officeId=damme"));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"rev-0001"');
    expect(JSON.parse(await res.text())).toMatchObject({ officeId: "damme", revision: "rev-0001" });
  });

  it("de kantorenlijst is ook zonder header bereikbaar", async () => {
    expect((await GET(request(""))).status).toBe(200);
  });

  it("een meegestuurde Authorization-header wordt genegeerd (nooit 401/503)", async () => {
    expect((await GET(request("?officeId=damme", "willekeurig"))).status).toBe(200);
  });

  it("antwoorden zijn nooit cachebaar (private, no-store) — ook 304", async () => {
    const responses = [
      await GET(request("?officeId=damme")),
      await GET(request("?officeId=damme", { "If-None-Match": '"rev-0001"' })),
      await GET(request("")),
    ];
    for (const res of responses) {
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
    }
  });

  it("alleen-lezen: elke schrijfmethode geeft 405", () => {
    for (const handler of [POST, PUT, PATCH, DELETE]) expect(handler().status).toBe(405);
  });
});

describe("api/central-master — kantorenlijst", () => {
  it("geeft alle geldige kantoren (gesorteerd) zonder artikelen of kostprijzen", async () => {
    const res = await GET(request(""));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.offices.map((o: { id: string }) => o.id)).toEqual(["damme", "lokeren"]);
    expect(body.offices[0]).toEqual({
      id: "damme",
      name: "Damme",
      revision: "rev-0001",
      generatedAt: "2026-10-01T12:00:00.000Z",
      articleCount: 2,
    });
    expect(text).not.toContain("costPrice");
  });

  it("een kapot bestand of een niet-kantoorbestand verbergt de andere kantoren niet en verschijnt niet", async () => {
    const body = JSON.parse(await (await GET(request(""))).text());
    expect(body.offices.map((o: { id: string }) => o.id)).not.toContain("kapot");
    expect(body.offices).toHaveLength(2);
  });

  it("een ontbrekende data-map geeft een lege lijst, geen crash", async () => {
    process.env.CENTRAL_MASTER_DATA_DIR = join(dir, "bestaat-niet");
    const res = await GET(request(""));
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).offices).toEqual([]);
  });
});

describe("api/central-master — voorwaardelijke aanvragen (ETag)", () => {
  it("If-None-Match met de actuele revision → 304 zonder body", async () => {
    for (const header of ['"rev-0001"', "W/\"rev-0001\"", 'x, "rev-0001"']) {
      const res = await GET(request("?officeId=damme", { "If-None-Match": header }));
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
    }
  });

  it("If-None-Match met een oude revision → 200 met de nieuwe inhoud", async () => {
    const res = await GET(request("?officeId=damme", { "If-None-Match": '"rev-oud"' }));
    expect(res.status).toBe(200);
  });

});

describe("api/central-master — invoer en bestanden", () => {
  it("onbekend kantoor → 404", async () => {
    expect((await GET(request("?officeId=gent"))).status).toBe(404);
  });

  it.each(["../secret-outside", "..%2Fsecret-outside", "damme/../../x", "DAMME", "", "damme.json", "%00"])(
    "pad-/vormmisbruik %j wordt geweigerd (geen path traversal)",
    async (officeId) => {
      const res = await GET(request(`?officeId=${officeId}`));
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("secret");
    },
  );

  it("een beschadigd bestand → 500 zonder inhoud te lekken", async () => {
    const res = await GET(request("?officeId=kapot"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("niet-json");
  });
});
