import { describe, expect, it, vi } from "vitest";
import { CentralMasterError } from "../../application/ports/CentralMasterSource";
import { makeMaster } from "../../application/services/centralMasterTestUtils";
import { HttpCentralMasterSource } from "./HttpCentralMasterSource";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function makeSource(fetchImpl: typeof fetch) {
  return new HttpCentralMasterSource({ fetchImpl });
}

const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CentralMasterError ? error.kind : `other:${String(error)}`;
  }
  return "ok";
};

describe("HttpCentralMasterSource.fetchOfficeMaster", () => {
  it("doet één GET zonder authenticatie (geen Authorization-header), zonder cookies en zonder cache, en valideert het antwoord", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeMaster()));
    const result = await makeSource(fetchImpl as unknown as typeof fetch).fetchOfficeMaster("damme");
    expect(result.kind).toBe("master");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/central-master?officeId=damme");
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(headers["If-None-Match"]).toBeUndefined();
  });

  it("stuurt If-None-Match met de gekende revision en vertaalt 304 naar 'unchanged'", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    const result = await makeSource(fetchImpl as unknown as typeof fetch).fetchOfficeMaster("damme", { knownRevision: "rev-0001" });
    expect(result).toEqual({ kind: "unchanged" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["If-None-Match"]).toBe('"rev-0001"');
  });

  it("is alleen-lezen: er bestaat geen publiceer-/schrijfmethode", () => {
    const source = makeSource(vi.fn() as unknown as typeof fetch);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(source)).filter(
      (n) => n !== "constructor" && !["request", "readJson", "asInvalid"].includes(n),
    );
    expect(methods.sort()).toEqual(["fetchOfficeIndex", "fetchOfficeMaster"]);
  });

  it.each([
    [401, "unavailable"],
    [403, "unavailable"],
    [404, "not-found"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("HTTP %i → %s", async (status, kind) => {
    const fetchImpl = (async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(fetchImpl).fetchOfficeMaster("damme"))).toBe(kind);
  });

  it("netwerkfout (offline) → unavailable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await kindOf(makeSource(fetchImpl).fetchOfficeMaster("damme"))).toBe("unavailable");
  });

  it("HTML-antwoord (SPA-fallback) → unavailable; kapotte JSON → invalid", async () => {
    const html = (async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(html).fetchOfficeMaster("damme"))).toBe("unavailable");
    const garbage = (async () =>
      new Response("{niet-json", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(garbage).fetchOfficeMaster("damme"))).toBe("invalid");
  });

  it("een bestand dat niet aan het schema voldoet of van een ander kantoor is → invalid", async () => {
    const wrongOffice = (async () => jsonResponse(makeMaster({ officeId: "lokeren" }))) as unknown as typeof fetch;
    expect(await kindOf(makeSource(wrongOffice).fetchOfficeMaster("damme"))).toBe("invalid");
    const broken = (async () => jsonResponse({ ...makeMaster(), articles: "nee" })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(broken).fetchOfficeMaster("damme"))).toBe("invalid");
  });

  it("encodeert het kantoor-id in de URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeMaster()));
    await kindOf(makeSource(fetchImpl as unknown as typeof fetch).fetchOfficeMaster("a&b=c"));
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/api/central-master?officeId=a%26b%3Dc");
  });
});

describe("HttpCentralMasterSource.fetchOfficeIndex", () => {
  it("leest de beveiligde kantorenlijst", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        schemaVersion: 1,
        offices: [{ id: "damme", name: "Damme", revision: "rev-0001", generatedAt: "2026-10-01T12:00:00.000Z", articleCount: 2 }],
      }),
    );
    const offices = await makeSource(fetchImpl as unknown as typeof fetch).fetchOfficeIndex();
    expect(offices).toEqual([expect.objectContaining({ id: "damme", name: "Damme" })]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/central-master");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("een ongeldige kantorenlijst → invalid; 401 (bv. van een host-bescherming) → gewoon unavailable, nooit een auth-fout", async () => {
    const bad = (async () => jsonResponse({ schemaVersion: 1, offices: "nee" })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(bad).fetchOfficeIndex())).toBe("invalid");
    const denied = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(denied).fetchOfficeIndex())).toBe("unavailable");
  });
});
