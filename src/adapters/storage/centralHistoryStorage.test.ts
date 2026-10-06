import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import type { CentralHistoryStatus } from "../../domain/centralHistoryFile";
import type { Office } from "../../domain/types";
import { AppDatabase } from "./db";
import { IndexedDbCountingRepository } from "./IndexedDbCountingRepository";

const status: CentralHistoryStatus = {
  officeId: "damme",
  lastAttemptAt: "2026-10-02T08:00:00.000Z",
  lastSuccessAt: "2026-10-02T08:00:00.000Z",
  lastError: null,
  lastGeneratedAt: "2026-10-01T12:00:00.000Z",
  lastAddedSessionCount: 2,
  centralSessionIds: ["s1", "s2"],
  centralSessionNames: ["2026-08 Maand"],
};

describe("Dexie v8 — centrale historiek (additief schema)", () => {
  it("is een versie ≥ 8 (de centrale-historiektabellen bestaan sinds v8)", () => {
    const db = new AppDatabase(`test-db-${Math.random()}`);
    expect(db.verno).toBeGreaterThanOrEqual(8);
  });

  it("upgradet een bestaande v7-database zonder dataverlies en maakt de nieuwe tabellen aan", async () => {
    const name = `migration-v7-${Math.random()}`;
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
    const office: Office = { id: "damme", name: "Damme", baseDate: null, locations: [] };
    await old.table("offices").put(office);
    await old.table("appState").put({ id: "singleton", selectedOfficeId: "damme" });
    old.close();

    const upgraded = new AppDatabase(name);
    const repository = new IndexedDbCountingRepository(upgraded);
    expect(await repository.getOffice("damme")).toEqual(office);
    expect(await repository.getSelectedOfficeId()).toBe("damme");
    expect(await repository.getCentralHistoryStatus("damme")).toBeUndefined();
    await repository.saveCentralHistoryStatus(status);
    expect(await repository.getCentralHistoryStatus("damme")).toEqual(status);
    upgraded.close();
  });
});

describe("IndexedDbCountingRepository — centrale historiek", () => {
  const make = () => new IndexedDbCountingRepository(new AppDatabase(`test-db-${Math.random()}`));

  it("bewaart status per kantoor (upsert) en houdt kantoren gescheiden", async () => {
    const repository = make();
    await repository.saveCentralHistoryStatus(status);
    await repository.saveCentralHistoryStatus({ ...status, lastError: "offline" });
    await repository.saveCentralHistoryStatus({ ...status, officeId: "lokeren", centralSessionIds: [] });
    expect((await repository.getCentralHistoryStatus("damme"))?.lastError).toBe("offline");
    expect((await repository.getCentralHistoryStatus("lokeren"))?.centralSessionIds).toEqual([]);
  });
});
