import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./db";
import { IndexedDbCountingRepository } from "./IndexedDbCountingRepository";
import type { Office } from "../../domain/types";

const office: Office = {
  id: "office-1",
  name: "Antwerpen",
  baseDate: "2026-09-01",
  locations: [1, 2, 3, 4, 5].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n as 1 | 2 | 3 | 4 | 5,
    name: `Locatie ${n}`,
  })),
};

describe("IndexedDbCountingRepository (via fake-indexeddb)", () => {
  let repository: IndexedDbCountingRepository;

  beforeEach(() => {
    // Elke test krijgt een eigen databasenaam, zodat tests elkaar niet raken.
    const db = new AppDatabase(`test-db-${Math.random()}`);
    repository = new IndexedDbCountingRepository(db);
  });

  it("bewaart en leest een kantoor terug", async () => {
    await repository.saveOffice(office);
    const loaded = await repository.getOffice("office-1");
    expect(loaded?.name).toBe("Antwerpen");
    expect(loaded?.locations).toHaveLength(5);
  });

  it("survives een refresh-scenario: sessie + entries blijven bewaard (autosave/herstel)", async () => {
    await repository.saveOffice(office);
    await repository.createSession({
      id: "session-1",
      officeId: "office-1",
      type: "MONTHLY",
      status: "ACTIVE",
      startedAt: new Date().toISOString(),
      completedAt: null,
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-09-01",
      articleIds: ["office-1:A1"],
    });
    await repository.saveCountEntry({
      id: "session-1:office-1:A1:office-1:loc-1",
      sessionId: "session-1",
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 0,
      counted: true,
      countedAt: new Date().toISOString(),
      note: null,
    });

    const active = await repository.getActiveSession("office-1");
    expect(active?.id).toBe("session-1");
    const entries = await repository.getCountEntries("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].quantity).toBe(0);
    expect(entries[0].counted).toBe(true);
  });
});
