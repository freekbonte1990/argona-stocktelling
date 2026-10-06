import { beforeEach, describe, expect, it } from "vitest";
import { CentralMasterError } from "../ports/CentralMasterSource";
import { CentralMasterSyncService } from "./CentralMasterSyncService";
import { CountingService } from "./CountingService";
import { CountSessionService } from "./CountSessionService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { FakeCentralMasterSource, makeMaster, makeMasterArticle, masterOffline } from "./centralMasterTestUtils";
import { makeEntry } from "./centralHistoryTestUtils";
import { CentralHistorySyncService } from "./CentralHistorySyncService";

let repository: InMemoryCountingRepository;
let source: FakeCentralMasterSource;
let service: CentralMasterSyncService;
let nowMs: number;

beforeEach(async () => {
  repository = new InMemoryCountingRepository();
  source = new FakeCentralMasterSource(makeMaster());
  nowMs = Date.parse("2026-10-06T08:00:00.000Z");
  service = new CentralMasterSyncService(repository, source, { now: () => new Date(nowMs) });
});

/** Alles wat tellingen/historiek is, in één vergelijkbare momentopname. */
async function countingSnapshot(officeId: string) {
  const sessions = await repository.getSessionsForOffice(officeId);
  return structuredClone({
    sessions,
    entries: await Promise.all(sessions.map((s) => repository.getCountEntries(s.id))),
    locationStatuses: await Promise.all(sessions.map((s) => repository.getLocationSessionStatuses(s.id))),
    finalized: await Promise.all(sessions.map((s) => repository.getFinalizedSessionResult(s.id))),
    historicalSheets: await repository.getHistoricalSheetSnapshots(officeId),
    history: await repository.getStockHistoryEntries(officeId),
  });
}

describe("CentralMasterSyncService — bootstrap op een leeg toestel", () => {
  it("er is geen toegangscode nodig: een leeg toestel kan meteen de kantorenlijst en de master ophalen", async () => {
    source.indexBehaviour = [{ id: "damme", name: "Damme", revision: "rev-0001", generatedAt: "2026-10-01T12:00:00.000Z", articleCount: 2 }];
    expect(await service.listOffices()).toMatchObject({ ok: true });
    expect((await service.syncOffice("damme", { force: true })).outcome).toBe("applied");
  });

  it("haalt de master op, valideert, slaat alles lokaal op en selecteert het kantoor", async () => {
    const result = await service.syncOffice("damme", { force: true, selectOffice: true });
    expect(result.outcome).toBe("applied");
    expect(await repository.getSelectedOfficeId()).toBe("damme");
    const office = await repository.getOffice("damme");
    expect(office?.locations.map((l) => l.name)).toEqual(["Magazijn", "Bestelwagen"]);
    expect((await repository.getArticles("damme")).map((a) => a.articleNumber).sort()).toEqual(["A1", "A2"]);
    expect(await repository.getArticleLocationAssignments("damme")).toHaveLength(2);
    expect((await repository.getProductCategories()).map((c) => c.name).sort()).toEqual(["Kabels", "Lampen"]);
    expect((await repository.getImportMeta("damme"))?.sourceFileName).toBe("Centrale master (rev-0001)");
    expect(await repository.getCentralMasterStatus("damme")).toMatchObject({ revision: "rev-0001", lastError: null });
  });

  it("een ongeldige master laat de lokale data volledig onaangeroerd (geen deelresultaat, geen wees-rij)", async () => {
    const rawBroken = makeMaster();
    (rawBroken.articles[0] as unknown as { countPeriod: string }).countPeriod = "???";
    // De bron-adapter valideert al; hier simuleren we dat de adapter 'invalid' rapporteert.
    source.set(new CentralMasterError("invalid", "articles[0]: onbekende countPeriod"));
    const result = await service.syncOffice("damme", { force: true, selectOffice: true });
    expect(result).toMatchObject({ outcome: "failed", kind: "invalid" });
    expect(await repository.getAllOffices()).toEqual([]);
    expect(await repository.getAllArticles()).toEqual([]);
    expect(await repository.getSelectedOfficeId()).toBeUndefined();
    expect(await repository.getCentralMasterStatus("damme")).toBeUndefined();
  });

  it("offline bij de eerste start: failed met een begrijpelijke melding en niets lokaal", async () => {
    source.set(masterOffline());
    const result = await service.syncOffice("damme", { force: true });
    expect(result).toMatchObject({ outcome: "failed", kind: "unavailable" });
    expect(result.message).toContain("niet bereikbaar");
    expect(await repository.getAllOffices()).toEqual([]);
  });

  it("not-found (niets gepubliceerd) en unavailable worden onderscheiden; een HTTP 401/403 van de host is gewoon 'niet bereikbaar'", async () => {
    source.set(new CentralMasterError("not-found", "x"));
    expect((await service.syncOffice("damme", { force: true })).outcome).toBe("not-found");
    source.set(new CentralMasterError("unavailable", "x"));
    const failed = await service.syncOffice("damme", { force: true });
    expect(failed).toMatchObject({ outcome: "failed", kind: "unavailable" });
    expect(failed.message).not.toMatch(/toegangscode|code/i);
  });
});

describe("CentralMasterSyncService — latere starts", () => {
  beforeEach(async () => {
    await service.syncOffice("damme", { force: true, selectOffice: true });
  });

  it("onveranderde revision → unchanged (de bron kreeg de toegepaste revision mee)", async () => {
    nowMs += 20 * 60 * 1000;
    const result = await service.syncOffice("damme");
    expect(result.outcome).toBe("unchanged");
    expect(source.lastKnownRevision).toBe("rev-0001");
  });

  it("throttle: binnen het interval wordt de bron niet opnieuw aangesproken", async () => {
    const calls = source.calls;
    nowMs += 60 * 1000;
    expect((await service.syncOffice("damme")).outcome).toBe("skipped-recent");
    expect(source.calls).toBe(calls);
    expect((await service.syncOffice("damme", { force: true })).outcome).toBe("unchanged");
  });

  it("een nieuwe revision wordt toegepast", async () => {
    source.set(makeMaster({ revision: "rev-0002", articles: [makeMasterArticle("A1", { description: "Vernieuwd" }), makeMasterArticle("A2", { categoryId: "cat-lampen" }), makeMasterArticle("A3")] }));
    nowMs += 20 * 60 * 1000;
    const result = await service.syncOffice("damme");
    expect(result).toMatchObject({ outcome: "applied", summary: { articlesAdded: 1, articlesUpdated: 1 } });
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.description).toBe("Vernieuwd");
    expect((await repository.getCentralMasterStatus("damme"))?.revision).toBe("rev-0002");
  });

  it("netwerkfout later: lokale data blijft ongewijzigd bruikbaar, laatste succes blijft zichtbaar, fout wordt intern bewaard", async () => {
    const before = await repository.getArticles("damme");
    source.set(masterOffline());
    nowMs += 20 * 60 * 1000;
    const result = await service.syncOffice("damme");
    expect(result.outcome).toBe("failed");
    expect(await repository.getArticles("damme")).toEqual(before);
    const status = await repository.getCentralMasterStatus("damme");
    expect(status).toMatchObject({ revision: "rev-0001", appliedAt: expect.any(String) });
    expect(status?.lastSuccessAt).toBe("2026-10-06T08:00:00.000Z");
    expect(status?.lastError).toContain("niet bereikbaar");
  });

  it("na een fout wordt de throttle niet toegepast: de volgende start probeert meteen opnieuw", async () => {
    source.set(masterOffline());
    nowMs += 20 * 60 * 1000;
    await service.syncOffice("damme");
    source.set(makeMaster());
    nowMs += 1000;
    expect((await service.syncOffice("damme")).outcome).toBe("unchanged");
  });

  it("gelijktijdige syncs van hetzelfde kantoor delen één aanvraag", async () => {
    const calls = source.calls;
    nowMs += 20 * 60 * 1000;
    const [a, b] = await Promise.all([service.syncOffice("damme"), service.syncOffice("damme")]);
    expect(a).toBe(b);
    expect(source.calls).toBe(calls + 1);
  });

  it("gooit nooit: ook een onverwachte fout wordt een 'failed'-resultaat", async () => {
    source.set(new Error("kaboom") as unknown as CentralMasterError);
    nowMs += 20 * 60 * 1000;
    const result = await service.syncOffice("damme");
    expect(result.outcome).toBe("failed");
  });

  it("herhaalde sync met dezelfde master maakt geen dubbels", async () => {
    const articles = await repository.getArticles("damme");
    for (let i = 0; i < 3; i += 1) {
      nowMs += 20 * 60 * 1000;
      await service.syncOffice("damme", { force: true });
    }
    expect(await repository.getArticles("damme")).toEqual(articles);
    expect(await repository.getArticleLocationAssignments("damme")).toHaveLength(2);
  });
});

describe("CentralMasterSyncService — actieve telling tijdens een master-update (volledig uitgesteld)", () => {
  it("de lopende telling, haar bevroren scope en ALLE telling-/historiektabellen blijven byte-gelijk; de master wacht", async () => {
    await service.syncOffice("damme", { force: true, selectOffice: true });
    const sessions = new CountSessionService(repository);
    const counting = new CountingService(repository);
    const session = await sessions.startSession("damme", "MONTHLY");
    await counting.recordCount({ session, articleId: "damme:A1", locationId: "damme:loc-1", quantity: 4 });
    await repository.saveStockHistoryEntries?.("damme", [makeEntry()]);

    const scopeBefore = { articleIds: [...session.articleIds], locationIds: [...(session.locationIds ?? [])] };
    const articlesBefore = await repository.getArticles("damme");
    const officeBefore = await repository.getOffice("damme");
    const assignmentsBefore = await repository.getArticleLocationAssignments("damme");
    const countingBefore = await countingSnapshot("damme");

    // Een ingrijpend nieuwe master: nieuw artikel, A2 weg, locatie hernoemd, kostprijs gewijzigd.
    source.set(
      makeMaster({
        revision: "rev-0002",
        locations: [
          { id: "damme:loc-1", number: 1, name: "Hernoemd magazijn", active: true },
          { id: "damme:loc-2", number: 2, name: "Bestelwagen", active: false },
          { id: "damme:loc-9", number: 3, name: "Nieuwe locatie", active: true },
        ],
        articles: [makeMasterArticle("A1", { costPrice: 99 }), makeMasterArticle("NIEUW")],
        assignments: [{ articleNumber: "NIEUW", locationId: "damme:loc-9", active: true }],
      }),
    );
    nowMs += 20 * 60 * 1000;
    const result = await service.syncOffice("damme");

    expect(result.outcome).toBe("deferred");
    // Niets in de stamdata veranderd:
    expect(await repository.getArticles("damme")).toEqual(articlesBefore);
    expect(await repository.getOffice("damme")).toEqual(officeBefore);
    expect(await repository.getArticleLocationAssignments("damme")).toEqual(assignmentsBefore);
    // Niets in tellingen/historiek veranderd:
    expect(await countingSnapshot("damme")).toEqual(countingBefore);
    const live = await repository.getSession(session.id);
    expect({ articleIds: live?.articleIds, locationIds: live?.locationIds }).toEqual(scopeBefore);
    // Wel genoteerd dat er iets wacht, en het kantoor blijft centraal beheerd:
    expect(await repository.getCentralMasterStatus("damme")).toMatchObject({
      revision: "rev-0001",
      pendingRevision: "rev-0002",
      lastError: null,
    });
  });

  it("na afronden/annuleren wordt de uitgestelde master bij de volgende sync toegepast — enkel voor VOLGENDE tellingen", async () => {
    await service.syncOffice("damme", { force: true, selectOffice: true });
    const sessions = new CountSessionService(repository);
    const session = await sessions.startSession("damme", "MONTHLY");
    source.set(makeMaster({ revision: "rev-0002", articles: [makeMasterArticle("A1"), makeMasterArticle("NIEUW")] }));
    nowMs += 20 * 60 * 1000;
    expect((await service.syncOffice("damme")).outcome).toBe("deferred");

    // Nog steeds actief → opnieuw uitgesteld (de throttle blokkeert een uitgestelde revision niet).
    nowMs += 1000;
    expect((await service.syncOffice("damme")).outcome).toBe("deferred");

    await sessions.cancelSession(session.id);
    nowMs += 1000;
    const applied = await service.syncOffice("damme");
    expect(applied.outcome).toBe("applied");
    expect(await repository.getCentralMasterStatus("damme")).toMatchObject({ revision: "rev-0002", pendingRevision: null });

    // De geannuleerde sessie bleef bevroren; een nieuwe sessie ziet de nieuwe masterdata.
    expect((await repository.getSession(session.id))?.articleIds).not.toContain("damme:NIEUW");
    const next = await sessions.startSession("damme", "MONTHLY");
    expect(next.articleIds).toContain("damme:NIEUW");
  });

  it("een afgeronde telling en haar bevroren resultaat blijven na een latere master-update identiek", async () => {
    await service.syncOffice("damme", { force: true, selectOffice: true });
    const sessions = new CountSessionService(repository);
    const counting = new CountingService(repository);
    const session = await sessions.startSession("damme", "MONTHLY");
    const expected = new Map((await repository.getArticleLocationAssignments("damme")).map((a) => [a.articleId, a.locationId]));
    for (const articleId of session.articleIds) {
      await counting.recordCount({ session, articleId, locationId: expected.get(articleId)!, quantity: 3 });
    }
    const office = await repository.getOffice("damme");
    for (const location of office!.locations.filter((l) => l.active)) {
      await counting.completeLocation(session.id, location.id);
    }
    await sessions.completeSession(session.id);
    const before = await countingSnapshot("damme");
    expect(before.finalized[0]).toBeDefined();

    source.set(
      makeMaster({
        revision: "rev-0002",
        articles: [makeMasterArticle("A1", { costPrice: 500, description: "Totaal anders" })],
        assignments: [],
      }),
    );
    nowMs += 20 * 60 * 1000;
    expect((await service.syncOffice("damme")).outcome).toBe("applied");

    expect(await countingSnapshot("damme")).toEqual(before);
    // De levende stam wél bijgewerkt:
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.costPrice).toBe(500);
  });
});

describe("CentralMasterSyncService + CentralHistorySyncService — onafhankelijk", () => {
  it("een master-sync raakt de historiek-statusrij niet", async () => {
    const history = new CentralHistorySyncService(repository, {
      label: "x",
      fetchOfficeHistory: async () => {
        throw new Error("niet gebruikt");
      },
    });
    expect(history).toBeDefined();
    await service.syncOffice("damme", { force: true });
    expect(await repository.getCentralHistoryStatus("damme")).toBeUndefined();
  });
});
