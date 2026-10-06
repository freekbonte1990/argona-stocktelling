import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { makeArticle, makeOffice } from "../../application/services/centralHistoryTestUtils";
import { makeMaster } from "../../application/services/centralMasterTestUtils";
import { planCentralMasterApply } from "../../domain/centralMasterPlan";
import type { CentralMasterStatus } from "../../domain/centralMasterFile";
import { AppDatabase } from "./db";
import { IndexedDbCountingRepository } from "./IndexedDbCountingRepository";

const NOW = "2026-10-06T08:00:00.000Z";
const make = () => {
  const db = new AppDatabase(`test-db-${Math.random()}`);
  return { db, repository: new IndexedDbCountingRepository(db) };
};
const status: CentralMasterStatus = {
  officeId: "damme",
  lastAttemptAt: NOW,
  lastSuccessAt: NOW,
  lastError: null,
  revision: "rev-0001",
  generatedAt: NOW,
  appliedAt: NOW,
  pendingRevision: null,
  articleIds: ["damme:A1"],
  locationIds: [],
  categoryIds: [],
  assignmentIds: [],
};

describe("Dexie v9 — centrale master (additief schema)", () => {
  it("is een versie ≥ 10", () => {
    expect(new AppDatabase(`test-db-${Math.random()}`).verno).toBeGreaterThanOrEqual(10);
  });

  it("upgradet een bestaande v9-database zonder dataverlies; de oude toegangscode-tabel (v8) verdwijnt met een eventueel bewaarde code", async () => {
    const name = `migration-v9-${Math.random()}`;
    const old = new Dexie(name);
    old.version(1).stores({
      offices: "id",
      articles: "id, officeId",
      sessions: "id, officeId, status",
      countEntries: "id, sessionId, articleId, locationId",
      assignments: "id, officeId, articleId, locationId, [officeId+locationId]",
      importMeta: "officeId",
    });
    old.version(2).stores({ appState: "id" });
    old.version(3).stores({ locationSessionStatuses: "id, sessionId, locationId, [sessionId+locationId]" });
    old.version(4).stores({
      historicalSheets: "id, officeId, sessionId",
      stockHistoryEntries: "id, officeId, articleId, sessionName",
    });
    old.version(5).stores({ finalizedSessionResults: "sessionId" });
    old.version(6).stores({ productCategories: "id, officeId" });
    old.version(7).stores({ productCategories: "id" });
    old.version(8).stores({ centralHistoryStatus: "officeId", centralHistoryConfig: "id" });
    old.version(9).stores({ centralMasterStatus: "officeId" });
    await old.table("offices").put(makeOffice());
    await old.table("articles").put(makeArticle("damme", "A1"));
    await old.table("appState").put({ id: "singleton", selectedOfficeId: "damme" });
    await old.table("centralHistoryConfig").put({ id: "singleton", accessCode: "een-oude-toegangscode" });
    await old.table("centralMasterStatus").put(status);
    old.close();

    const upgraded = new AppDatabase(name);
    const repository = new IndexedDbCountingRepository(upgraded);
    expect((await repository.getOffice("damme"))?.name).toBe("Damme");
    expect(await repository.getArticles("damme")).toHaveLength(1);
    expect(await repository.getSelectedOfficeId()).toBe("damme");
    expect(await repository.getCentralMasterStatus("damme")).toEqual(status);
    // De code-opslag bestaat niet meer:
    expect(upgraded.tables.map((t) => t.name)).not.toContain("centralHistoryConfig");
    await upgraded.open();
    const raw = new Dexie(name);
    await raw.open();
    expect(raw.tables.map((t) => t.name)).not.toContain("centralHistoryConfig");
    raw.close();
    upgraded.close();
  });
});

describe("IndexedDbCountingRepository — centrale master", () => {
  it("bewaart status per kantoor (upsert) en houdt kantoren gescheiden", async () => {
    const { repository } = make();
    await repository.saveCentralMasterStatus(status);
    await repository.saveCentralMasterStatus({ ...status, lastError: "offline" });
    await repository.saveCentralMasterStatus({ ...status, officeId: "lokeren", articleIds: [] });
    expect((await repository.getCentralMasterStatus("damme"))?.lastError).toBe("offline");
    expect((await repository.getCentralMasterStatus("lokeren"))?.articleIds).toEqual([]);
  });

  it("applyCentralMaster schrijft alles in één keer en selecteert het kantoor", async () => {
    const { repository } = make();
    const plan = planCentralMasterApply({ master: makeMaster(), local: { office: undefined, articles: [], allArticles: [], assignments: [], categories: [] }, previousStatus: undefined, now: NOW, selectOffice: true });
    await repository.applyCentralMaster(plan);
    expect(await repository.getArticles("damme")).toHaveLength(2);
    expect(await repository.getArticleLocationAssignments("damme")).toHaveLength(2);
    expect(await repository.getProductCategories()).toHaveLength(2);
    expect((await repository.getImportMeta("damme"))?.sourceFileName).toBe("Centrale master (rev-0001)");
    expect(await repository.getSelectedOfficeId()).toBe("damme");
    expect((await repository.getCentralMasterStatus("damme"))?.appliedAt).toBe(NOW);
  });

  it("is atomisch: faalt een schrijfactie halverwege, dan blijft ALLES zoals het was (geen halve master)", async () => {
    const { db, repository } = make();
    await repository.saveOffice({ ...makeOffice(), name: "Oud" });
    await repository.saveArticles([makeArticle("damme", "OUD")]);
    const plan = planCentralMasterApply({ master: makeMaster(), local: { office: makeOffice(), articles: [makeArticle("damme", "OUD")], allArticles: [], assignments: [], categories: [] }, previousStatus: undefined, now: NOW, selectOffice: true });
    // Saboteer de LAATSTE schrijfactie (de status) → de hele transactie moet terugdraaien.
    const original = db.centralMasterStatus.put.bind(db.centralMasterStatus);
    db.centralMasterStatus.put = (() => Promise.reject(new Error("schijf vol"))) as unknown as typeof db.centralMasterStatus.put;
    await expect(repository.applyCentralMaster(plan)).rejects.toThrow();
    db.centralMasterStatus.put = original;

    expect((await repository.getOffice("damme"))?.name).toBe("Oud");
    expect((await repository.getArticles("damme")).map((a) => a.articleNumber)).toEqual(["OUD"]);
    expect(await repository.getProductCategories()).toEqual([]);
    expect(await repository.getArticleLocationAssignments("damme")).toEqual([]);
    expect(await repository.getImportMeta("damme")).toBeUndefined();
    expect(await repository.getSelectedOfficeId()).toBeUndefined();
    expect(await repository.getCentralMasterStatus("damme")).toBeUndefined();
  });

  it("raakt structureel nooit sessies, tellingen, locatiestatussen, bevroren resultaten of historiek", async () => {
    const { db, repository } = make();
    await repository.saveOffice(makeOffice());
    await repository.saveArticles([makeArticle("damme", "A1")]);
    await repository.createSession({
      id: "s1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: NOW,
      completedAt: NOW,
      sourceFileName: "x",
      sourceBaseDate: null,
      articleIds: ["damme:A1"],
      locationIds: ["damme:loc-1"],
    });
    await repository.saveCountEntry({
      id: "s1:damme:A1:damme:loc-1",
      sessionId: "s1",
      articleId: "damme:A1",
      locationId: "damme:loc-1",
      quantity: 5,
      counted: true,
      countedAt: NOW,
      note: null,
      resolution: "COUNTED",
    });
    const tables = ["sessions", "countEntries", "locationSessionStatuses", "finalizedSessionResults", "historicalSheets", "stockHistoryEntries", "centralHistoryStatus"] as const;
    const dump = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await db.table(t).toArray()])));
    const before = await dump();

    const local = { office: await repository.getOffice("damme"), articles: await repository.getArticles("damme"), allArticles: await repository.getAllArticles(), assignments: [], categories: [] };
    await repository.applyCentralMaster(planCentralMasterApply({ master: makeMaster({ articles: [], assignments: [], revision: "rev-0009" }), local, previousStatus: status, now: NOW }));

    expect(await dump()).toEqual(before);
  });
});
