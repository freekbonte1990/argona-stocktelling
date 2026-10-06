import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../../../api/central-history";
import { buildPublication } from "../../../scripts/centralHistoryPublication";
import { AnalysisService } from "../../application/services/AnalysisService";
import { CentralHistorySyncService } from "../../application/services/CentralHistorySyncService";
import { ComparisonService } from "../../application/services/ComparisonService";
import { CountSessionService, CentralSessionDeletionNotAllowedError } from "../../application/services/CountSessionService";
import { ImportService } from "../../application/services/ImportService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import { ProductCategoryService } from "../../application/services/ProductCategoryService";
import { serializeCentralHistoryFile, type CentralHistoryFile } from "../../domain/centralHistoryFile";
import { createExcelStockSourceFromBuffer } from "../excel/ExcelStockSource";
import { loadFixtureBuffer, produceDeviceAExport } from "../../../test-support/exportFlow";
import { HttpCentralHistorySource } from "./HttpCentralHistorySource";

/**
 * HARDE acceptatie van de centrale read-only historiek, end-to-end over de
 * échte keten: toestel A telt/exporteert → publish-logica → bestand in de
 * (niet-publieke) data-map → het BEVEILIGDE endpoint (`api/central-history`) →
 * `HttpCentralHistorySource` → `CentralHistorySyncService` → een volledig
 * lege toestel B → Analyse + Vergelijken → offline → herhaalde sync.
 */

const TOKEN = "integration-token-0123456789abcdef";
const FIXTURE = "Stocktelling_Lokeren_standaard.xlsx";
const OFFICE = "lokeren";

let dataDir: string;
let published: CentralHistoryFile;
let sessionAId: string;
const originalEnv = { ...process.env };

/** `fetch` die rechtstreeks de serverless-handler aanroept (zoals Vercel dat doet). */
function endpointFetch(state: { online: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!state.online) throw new TypeError("Failed to fetch");
    return GET(new Request(`https://argona.test${String(input)}`, { headers: init?.headers }));
  }) as typeof fetch;
}

async function makeEmptyDeviceB(accessCode: string | null, state: { online: boolean }) {
  const repository = new InMemoryCountingRepository();
  const importService = new ImportService(repository);
  // Toestel B kent enkel het MASTERbestand (geen historiek, geen sessies).
  const master = createExcelStockSourceFromBuffer(loadFixtureBuffer(FIXTURE), FIXTURE);
  await importService.commitImport(await importService.prepareImport(master));
  if (accessCode) await repository.setCentralHistoryAccessCode(accessCode);
  const sync = new CentralHistorySyncService(
    repository,
    new HttpCentralHistorySource({
      getAccessCode: () => repository.getCentralHistoryAccessCode(),
      fetchImpl: endpointFetch(state),
    }),
  );
  const categories = new ProductCategoryService(repository);
  return {
    repository,
    sync,
    analysis: new AnalysisService(repository, categories),
    comparison: new ComparisonService(repository, categories),
    sessions: new CountSessionService(repository),
  };
}

beforeAll(async () => {
  const { session, exported } = await produceDeviceAExport(FIXTURE, OFFICE);
  sessionAId = session.id;
  const publication = await buildPublication({
    buffer: exported.data,
    fileName: exported.fileName,
    existing: null,
    generatedAt: "2026-10-01T12:00:00.000Z",
  });
  // Een tweede, eerdere centrale sessie (juli) zodat er iets te VERGELIJKEN valt.
  const july = publication.file.entries.map((e) => ({
    ...e,
    sessionName: "2026-07 Maand",
    countDate: "2026-07-31",
    sourceSessionId: "session-july",
    totalCount: e.totalCount === null ? null : Math.max(0, e.totalCount - 2),
  }));
  published = { ...publication.file, entries: [...july, ...publication.file.entries] };

  dataDir = mkdtempSync(join(tmpdir(), "central-history-int-"));
  writeFileSync(join(dataDir, `${OFFICE}.json`), serializeCentralHistoryFile(published));
  process.env.CENTRAL_HISTORY_DATA_DIR = dataDir;
  process.env.CENTRAL_HISTORY_TOKENS = TOKEN;
}, 60_000);

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe("centrale historiek — lege device → centraal → Analyse/Vergelijken → offline → herhaald", () => {
  it("lege device met geldige code: sessies verschijnen met stabiele ID's; Analyse en Vergelijken werken", async () => {
    const online = { online: true };
    const b = await makeEmptyDeviceB(TOKEN, online);
    expect(await b.repository.getSessionsForOffice(OFFICE)).toHaveLength(0);

    const result = await b.sync.syncOffice(OFFICE);
    expect(result).toMatchObject({ outcome: "synced", addedSessionCount: 2, message: null });

    const sessions = await b.repository.getSessionsForOffice(OFFICE);
    expect(sessions.map((s) => s.id).sort()).toEqual([sessionAId, "session-july"].sort());
    expect(sessions.every((s) => s.status === "COMPLETED")).toBe(true);

    const analysis = await b.analysis.getSessionAnalysis(sessionAId);
    expect(analysis.kpis.articlesInScope).toBeGreaterThan(0);
    expect(analysis.kpis.totalStockValue).toBeGreaterThan(0);

    const options = await b.comparison.getComparisonOptions(OFFICE);
    expect(options.sessions.map((o) => o.sessionId)).toEqual(expect.arrayContaining([sessionAId, "session-july"]));
    const comparison = await b.comparison.compareSessions(OFFICE, "session-july", sessionAId);
    expect(comparison.headerA.sessionName).toBe("2026-07 Maand");
    expect(comparison.articles.length).toBeGreaterThan(0);
  }, 60_000);

  it("daarna offline: Analyse/Vergelijken blijven werken, de mislukte poging wijzigt niets en blokkeert niets", async () => {
    const net = { online: true };
    const b = await makeEmptyDeviceB(TOKEN, net);
    await b.sync.syncOffice(OFFICE);
    const before = await b.repository.getStockHistoryEntries(OFFICE);

    net.online = false;
    const offline = await b.sync.syncOffice(OFFICE, { force: true });
    expect(offline.outcome).toBe("failed");
    expect(offline.message).toContain("niet bereikbaar");

    expect(await b.repository.getStockHistoryEntries(OFFICE)).toEqual(before);
    expect((await b.analysis.getSessionAnalysis(sessionAId)).kpis.articlesInScope).toBeGreaterThan(0);
    expect((await b.comparison.compareSessions(OFFICE, "session-july", sessionAId)).articles.length).toBeGreaterThan(0);
    const status = await b.repository.getCentralHistoryStatus(OFFICE);
    expect(status?.lastSuccessAt).not.toBeNull(); // laatste SUCCES blijft zichtbaar
    expect(status?.lastError).toContain("niet bereikbaar");
  }, 60_000);

  it("herhaalde sync (ook na offline herstel) levert nooit dubbels op", async () => {
    const net = { online: true };
    const b = await makeEmptyDeviceB(TOKEN, net);
    await b.sync.syncOffice(OFFICE);
    net.online = false;
    await b.sync.syncOffice(OFFICE, { force: true });
    net.online = true;
    for (let i = 0; i < 3; i += 1) {
      const again = await b.sync.syncOffice(OFFICE, { force: true });
      expect(again).toMatchObject({ outcome: "synced", addedSessionCount: 0 });
    }
    expect(await b.repository.getSessionsForOffice(OFFICE)).toHaveLength(2);
    expect(await b.repository.getStockHistoryEntries(OFFICE)).toHaveLength(published.entries.length);
    expect((await b.comparison.getComparisonOptions(OFFICE)).sessions.length).toBe(2);
  }, 60_000);

  it("een tweede toestel krijgt exact dezelfde sessie-identiteit (geen heuristiek op naam)", async () => {
    const one = await makeEmptyDeviceB(TOKEN, { online: true });
    const two = await makeEmptyDeviceB(TOKEN, { online: true });
    await one.sync.syncOffice(OFFICE);
    await two.sync.syncOffice(OFFICE);
    const ids = async (d: typeof one) => (await d.repository.getSessionsForOffice(OFFICE)).map((s) => s.id).sort();
    expect(await ids(one)).toEqual(await ids(two));
  }, 60_000);

  it("centrale sessies zijn niet verwijderbaar in de gewone app", async () => {
    const b = await makeEmptyDeviceB(TOKEN, { online: true });
    await b.sync.syncOffice(OFFICE);
    await expect(b.sessions.deleteSession(sessionAId)).rejects.toBeInstanceOf(CentralSessionDeletionNotAllowedError);
    expect(await b.repository.getSession(sessionAId)).toBeDefined();
  }, 60_000);
});

describe("centrale historiek — security over de volledige keten", () => {
  it("zonder toegangscode op het toestel: er wordt niets opgehaald en de app werkt gewoon", async () => {
    const b = await makeEmptyDeviceB(null, { online: true });
    const result = await b.sync.syncOffice(OFFICE);
    expect(result.outcome).toBe("not-configured");
    expect(await b.repository.getSessionsForOffice(OFFICE)).toHaveLength(0);
  }, 60_000);

  it("met een foute toegangscode: geweigerd, geen enkele data lokaal, discrete melding", async () => {
    const b = await makeEmptyDeviceB("een-totaal-foute-code-123", { online: true });
    const result = await b.sync.syncOffice(OFFICE);
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("Toegangscode geweigerd");
    expect(await b.repository.getStockHistoryEntries(OFFICE)).toHaveLength(0);
  }, 60_000);

  it("het endpoint geeft zonder/met foute code NOOIT aantallen of kostprijzen terug", async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: "Bearer fout-fout-fout-fout-fout" }]) {
      const res = await GET(new Request(`https://argona.test/api/central-history?officeId=${OFFICE}`, { headers }));
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).not.toContain("costPrice");
      expect(body).not.toContain("totalCount");
    }
  });
});
