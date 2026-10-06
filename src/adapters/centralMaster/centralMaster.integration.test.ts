import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as historyGET } from "../../../api/central-history";
import { GET as masterGET } from "../../../api/central-master";
import { buildPublication } from "../../../scripts/centralHistoryPublication";
import { buildMasterPublication, serializeCentralMasterFile } from "../../../scripts/centralMasterPublication";
import { loadFixtureBuffer, produceDeviceAExport } from "../../../test-support/exportFlow";
import { CentralDataSyncService } from "../../application/services/CentralDataSyncService";
import { CentralHistorySyncService } from "../../application/services/CentralHistorySyncService";
import { CentralMasterSyncService } from "../../application/services/CentralMasterSyncService";
import { CountingService } from "../../application/services/CountingService";
import { CountSessionService } from "../../application/services/CountSessionService";
import { ImportService } from "../../application/services/ImportService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import { ProductCategoryService } from "../../application/services/ProductCategoryService";
import { serializeCentralHistoryFile } from "../../domain/centralHistoryFile";
import type { CentralMasterFile } from "../../domain/centralMasterFile";
import { createExcelStockSourceFromBuffer } from "../excel/ExcelStockSource";
import { HttpCentralHistorySource } from "../centralHistory/HttpCentralHistorySource";
import { HttpCentralMasterSource } from "./HttpCentralMasterSource";

/**
 * HARDE acceptatie van de centrale MASTERDATA, end-to-end over de échte keten:
 * Excel → publish-logica → bestand in de (niet-publieke) data-map → de BEVEILIGDE
 * endpoints → HTTP-adapters → sync-services → een volledig lege, NIEUWE tablet →
 * kantoor kiezen → master + historiek → tellen → offline → herhaalde sync.
 */
const FIXTURE = "Stocktelling_Lokeren_standaard.xlsx";
const OFFICE = "lokeren";
const originalEnv = { ...process.env };

let masterDir: string;
let historyDir: string;
let published: CentralMasterFile;

function endpointFetch(net: { online: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!net.online) throw new TypeError("Failed to fetch");
    const url = `https://argona.test${String(input)}`;
    const request = new Request(url, { headers: init?.headers });
    return String(input).startsWith("/api/central-master") ? masterGET(request) : historyGET(request);
  }) as typeof fetch;
}

function makeNewTablet(net: { online: boolean }) {
  const repository = new InMemoryCountingRepository();
  const fetchImpl = endpointFetch(net);
  const data = new CentralDataSyncService(
    repository,
    new CentralMasterSyncService(repository, new HttpCentralMasterSource({ fetchImpl })),
    new CentralHistorySyncService(repository, new HttpCentralHistorySource({ fetchImpl })),
  );
  return {
    repository,
    data,
    sessions: new CountSessionService(repository),
    counting: new CountingService(repository),
    categories: new ProductCategoryService(repository),
  };
}

async function countEverything(t: ReturnType<typeof makeNewTablet>, quantity: (previous: number | null) => number) {
  const session = await t.sessions.startSession(OFFICE, "MONTHLY");
  const office = (await t.repository.getOffice(OFFICE))!;
  const firstActive = office.locations.find((l) => l.active)!;
  const assigned = new Map<string, string>();
  for (const a of (await t.repository.getArticleLocationAssignments(OFFICE)).filter((x) => x.active)) {
    if (!assigned.has(a.articleId)) assigned.set(a.articleId, a.locationId);
  }
  const articles = new Map((await t.repository.getArticles(OFFICE)).map((a) => [a.id, a]));
  for (const articleId of session.articleIds) {
    await t.counting.recordCount({
      session,
      articleId,
      locationId: assigned.get(articleId) ?? firstActive.id,
      quantity: quantity(articles.get(articleId)?.previousCount ?? null),
    });
  }
  for (const location of office.locations.filter((l) => l.active)) {
    await t.counting.completeLocation(session.id, location.id);
  }
  await t.sessions.completeSession(session.id);
  return session;
}

beforeAll(async () => {
  // Toestel A (de huidige Excel-werkwijze) telt een volledige maand → bron voor master én historiek.
  const { exported } = await produceDeviceAExport(FIXTURE, OFFICE, 2);

  const master = await buildMasterPublication({ buffer: loadFixtureBuffer(FIXTURE), fileName: FIXTURE, generatedAt: "2026-10-01T12:00:00.000Z" });
  published = master.file;
  masterDir = mkdtempSync(join(tmpdir(), "central-master-int-"));
  writeFileSync(join(masterDir, `${OFFICE}.json`), serializeCentralMasterFile(published));

  const history = await buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: null, generatedAt: "2026-10-01T12:00:00.000Z" });
  historyDir = mkdtempSync(join(tmpdir(), "central-history-int-"));
  writeFileSync(join(historyDir, `${OFFICE}.json`), serializeCentralHistoryFile(history.file));

  process.env.CENTRAL_MASTER_DATA_DIR = masterDir;
  process.env.CENTRAL_HISTORY_DATA_DIR = historyDir;
}, 120_000);

afterAll(() => {
  rmSync(masterDir, { recursive: true, force: true });
  rmSync(historyDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe("centrale master — nieuw toestel → master → historiek → tellen → offline → herhaald", () => {
  it("1. bootstrap: kantorenlijst → kiezen → master + historiek lokaal; zonder code en zonder één Excel-import", async () => {
    const net = { online: true };
    const t = makeNewTablet(net);
    expect(await t.repository.getAllOffices()).toEqual([]);

    const list = await t.data.listOffices();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.offices.map((o) => o.id)).toEqual([OFFICE]);

    const result = await t.data.bootstrapOffice(OFFICE);
    expect(result).toMatchObject({ ok: true, message: null });
    expect(result.master.outcome).toBe("applied");
    expect(result.history?.outcome).toBe("synced");

    expect(await t.repository.getSelectedOfficeId()).toBe(OFFICE);
    const local = await t.repository.getArticles(OFFICE);
    const localIds = new Set(local.map((a) => a.id));
    expect(published.articles.every((a) => localIds.has(`${OFFICE}:${a.articleNumber}`))).toBe(true);
    // Eventuele extra artikelen zijn enkel historische stubs (artikelen die enkel in de historiek voorkomen, bv. oude TMP's).
    const masterIds = new Set(published.articles.map((a) => `${OFFICE}:${a.articleNumber}`));
    for (const extra of local.filter((a) => !masterIds.has(a.id))) expect(extra.idType).toBe("CENTRALE HISTORIEK");
    expect((await t.repository.getOffice(OFFICE))?.locations.length).toBe(published.locations.length);
    expect((await t.repository.getSessionsForOffice(OFFICE)).map((s) => s.status)).toEqual(["COMPLETED"]);
  }, 120_000);

  it("2. 'Vorige telling' komt uitsluitend uit de historiek (master heeft geen previousCount)", async () => {
    const t = makeNewTablet({ online: true });
    await t.data.bootstrapOffice(OFFICE);
    const history = await t.repository.getStockHistoryEntries(OFFICE);
    const counted = history.filter((e) => e.status === "GETELD" && e.totalCount !== null);
    expect(counted.length).toBeGreaterThan(0);
    const articles = new Map((await t.repository.getArticles(OFFICE)).map((a) => [a.id, a]));
    for (const entry of counted.slice(0, 50)) {
      expect(articles.get(entry.articleId)?.previousCount).toBe(entry.totalCount);
    }
  }, 120_000);

  it("3. tellen op de nieuwe tablet: volledige telling afronden; productgamma's komen uit de master (geen lokale migratie)", async () => {
    const t = makeNewTablet({ online: true });
    await t.data.bootstrapOffice(OFFICE);
    const session = await countEverything(t, (previous) => (previous ?? 0) + 1);
    expect((await t.repository.getSession(session.id))?.status).toBe("COMPLETED");
    expect(await t.repository.getFinalizedSessionResult(session.id)).toBeDefined();
    expect((await t.repository.getSessionsForOffice(OFFICE)).length).toBe(2);

    const ids = new Set(published.categories.map((c) => c.id));
    expect((await t.repository.getProductCategories()).map((c) => c.id).sort()).toEqual([...ids].sort());
    await t.categories.listCategories(OFFICE); // mag nooit een lokale migratie triggeren
    expect((await t.repository.getProductCategories()).length).toBe(ids.size);
    expect((await t.repository.getOffice(OFFICE))?.categoriesMigrated).toBe(true);
  }, 120_000);

  it("4. offline: tellen blijft werken, een mislukte sync wijzigt niets; terug online: geen dubbels en 'onveranderd' via 304", async () => {
    const net = { online: true };
    const t = makeNewTablet(net);
    await t.data.bootstrapOffice(OFFICE);

    net.online = false;
    const articlesBefore = await t.repository.getArticles(OFFICE);
    const failed = await t.data.syncOffice(OFFICE, { force: true });
    expect(failed.master.outcome).toBe("failed");
    expect(failed.history.outcome).toBe("failed");
    expect(await t.repository.getArticles(OFFICE)).toEqual(articlesBefore);

    const offlineSession = await countEverything(t, () => 3);
    expect((await t.repository.getSession(offlineSession.id))?.status).toBe("COMPLETED");

    net.online = true;
    const sessionsBefore = (await t.repository.getSessionsForOffice(OFFICE)).length;
    const historyBefore = (await t.repository.getStockHistoryEntries(OFFICE)).length;
    const again = await t.data.syncOffice(OFFICE, { force: true });
    expect(again.master.outcome).toBe("unchanged");
    expect(again.history.outcome).toBe("synced");
    expect((await t.repository.getSessionsForOffice(OFFICE)).length).toBe(sessionsBefore);
    expect((await t.repository.getStockHistoryEntries(OFFICE)).length).toBe(historyBefore);
    // De eigen, lokaal afgeronde telling is niet overschreven door de centrale historiek:
    expect((await t.repository.getSession(offlineSession.id))?.status).toBe("COMPLETED");
  }, 120_000);

  it("5. de app vraagt nergens een toegangscode: er bestaat geen code-opslag en de endpoints antwoorden zonder Authorization-header", async () => {
    const t = makeNewTablet({ online: true });
    expect("setCentralHistoryAccessCode" in t.repository).toBe(false);
    expect("saveAccessCode" in t.data).toBe(false);
    const res = await masterGET(new Request("https://argona.test/api/central-master"));
    expect(res.status).toBe(200);
    expect((await historyGET(new Request(`https://argona.test/api/central-history?officeId=${OFFICE}`))).status).toBe(200);
    expect((await t.data.bootstrapOffice(OFFICE)).ok).toBe(true);
  }, 120_000);

  it("6. actieve telling tijdens een master-update: scope bevroren, update uitgesteld en daarna toegepast", async () => {
    const net = { online: true };
    const t = makeNewTablet(net);
    await t.data.bootstrapOffice(OFFICE);

    const session = await t.sessions.startSession(OFFICE, "MONTHLY");
    const scope = [...session.articleIds];
    const locations = [...(session.locationIds ?? [])];

    // Beheerder publiceert een nieuwe master: hernoemd artikel + extra artikel.
    const updated: CentralMasterFile = {
      ...published,
      revision: "nieuwe-rev-0002",
      articles: [
        { ...published.articles[0], description: "Hernoemd door de beheerder", costPrice: 123.45 },
        ...published.articles.slice(1),
        { ...published.articles[0], articleNumber: "NIEUW-ARTIKEL", description: "Nieuw", countPeriod: "MONTHLY" },
      ],
    };
    mkdirSync(masterDir, { recursive: true });
    writeFileSync(join(masterDir, `${OFFICE}.json`), serializeCentralMasterFile(updated));

    try {
      const during = await t.data.syncOffice(OFFICE, { force: true });
      expect(during.master.outcome).toBe("deferred");
      const live = await t.repository.getSession(session.id);
      expect(live?.articleIds).toEqual(scope);
      expect(live?.locationIds).toEqual(locations);
      expect((await t.repository.getArticles(OFFICE)).find((a) => a.articleNumber === "NIEUW-ARTIKEL")).toBeUndefined();
      expect((await t.repository.getCentralMasterStatus(OFFICE))?.pendingRevision).toBe("nieuwe-rev-0002");

      await t.sessions.cancelSession(session.id);
      const after = await t.data.syncOffice(OFFICE, { force: true });
      expect(after.master.outcome).toBe("applied");
      expect((await t.repository.getArticles(OFFICE)).find((a) => a.articleNumber === "NIEUW-ARTIKEL")).toBeDefined();
      const next = await t.sessions.startSession(OFFICE, "MONTHLY");
      expect(next.articleIds).toContain(`${OFFICE}:NIEUW-ARTIKEL`);
    } finally {
      writeFileSync(join(masterDir, `${OFFICE}.json`), serializeCentralMasterFile(published));
    }
  }, 120_000);

  it("7. adoptie: een bestaand Excel-toestel krijgt de master zonder dat tellingen of TMP-artikelen verloren gaan", async () => {
    const t = makeNewTablet({ online: true });
    const importService = new ImportService(t.repository);
    const source = createExcelStockSourceFromBuffer(loadFixtureBuffer(FIXTURE), FIXTURE);
    await importService.commitImport(await importService.prepareImport(source));
    const session = await countEverything(t, (previous) => (previous ?? 0) + 5);
    const tmpId = `${OFFICE}:TMP-LOK-9999`;
    const base = (await t.repository.getArticles(OFFICE))[0];
    await t.repository.saveArticles([{ ...base, id: tmpId, articleNumber: "TMP-LOK-9999", idType: "TIJDELIJK", description: "Veldartikel" }]);
    const entriesBefore = await t.repository.getCountEntries(session.id);
    const resultBefore = await t.repository.getFinalizedSessionResult(session.id);

    const sync = await t.data.syncOffice(OFFICE, { force: true });
    expect(sync.master.outcome).toBe("applied");

    expect(await t.repository.getCountEntries(session.id)).toEqual(entriesBefore);
    expect(await t.repository.getFinalizedSessionResult(session.id)).toEqual(resultBefore);
    expect((await t.repository.getSession(session.id))?.status).toBe("COMPLETED");
    expect((await t.repository.getArticles(OFFICE)).find((a) => a.id === tmpId)).toMatchObject({ description: "Veldartikel", idType: "TIJDELIJK" });
    expect((await t.repository.getCentralMasterStatus(OFFICE))?.appliedAt).not.toBeNull();
  }, 120_000);
});
