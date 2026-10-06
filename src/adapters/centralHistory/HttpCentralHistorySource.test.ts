import { describe, expect, it, vi } from "vitest";
import { makeEntry, makeFile } from "../../application/services/centralHistoryTestUtils";
import { CentralHistoryError } from "../../application/ports/CentralHistorySource";
import { HttpCentralHistorySource } from "./HttpCentralHistorySource";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

function makeSource(fetchImpl: typeof fetch, code: string | null = "een-geldige-toegangscode") {
  return new HttpCentralHistorySource({ getAccessCode: async () => code ?? undefined, fetchImpl });
}

const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CentralHistoryError ? error.kind : `other:${String(error)}`;
  }
  return "ok";
};

describe("HttpCentralHistorySource", () => {
  it("doet één GET met Bearer-code, zonder cookies en zonder cache, en valideert het antwoord", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(makeFile([makeEntry()])));
    const file = await makeSource(fetchImpl as unknown as typeof fetch).fetchOfficeHistory("damme");
    expect(file.entries).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/central-history?officeId=damme");
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer een-geldige-toegangscode");
  });

  it("is alleen-lezen: er bestaat geen publiceer-/schrijfmethode", () => {
    const source = makeSource(vi.fn() as unknown as typeof fetch);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(source)).filter((n) => n !== "constructor");
    expect(methods).toEqual(["fetchOfficeHistory"]);
  });

  it("zonder toegangscode: not-configured, zonder netwerkcall", async () => {
    const fetchImpl = vi.fn();
    expect(await kindOf(makeSource(fetchImpl as unknown as typeof fetch, null).fetchOfficeHistory("damme"))).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("HTTP %i → %s", async (status, kind) => {
    const fetchImpl = (async () => new Response("{}", { status })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(fetchImpl).fetchOfficeHistory("damme"))).toBe(kind);
  });

  it("netwerkfout (offline) → unavailable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await kindOf(makeSource(fetchImpl).fetchOfficeHistory("damme"))).toBe("unavailable");
  });

  it("HTML-antwoord (SPA-fallback, bv. in vite dev) → unavailable, geen crash", async () => {
    const fetchImpl = (async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(fetchImpl).fetchOfficeHistory("damme"))).toBe("unavailable");
  });

  it("kapotte JSON of een bestand van een ander kantoor → invalid", async () => {
    const broken = (async () =>
      new Response("{nope", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await kindOf(makeSource(broken).fetchOfficeHistory("damme"))).toBe("invalid");
    const other = (async () => jsonResponse(makeFile([], { officeId: "lokeren" }))) as unknown as typeof fetch;
    expect(await kindOf(makeSource(other).fetchOfficeHistory("damme"))).toBe("invalid");
  });

  it("een time-out (hangende server) → unavailable", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const source = new HttpCentralHistorySource({ getAccessCode: async () => "code-code-code-code", fetchImpl: hanging, timeoutMs: 20 });
    expect(await kindOf(source.fetchOfficeHistory("damme"))).toBe("unavailable");
  });
});
