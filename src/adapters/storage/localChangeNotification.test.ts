import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { db, onLocalDataChanged } from "./db";

describe("onLocalDataChanged", () => {
  it("meldt wijzigingen aan echte data, maar niet aan de eigen sync-administratie", async () => {
    await db.open();
    await new Promise((r) => setTimeout(r, 50)); // eventuele "database geopend"-melding laten passeren
    const listener = vi.fn();
    const stop = onLocalDataChanged(listener);
    try {
      await db.syncState.put({ id: "damme|cursor", officeId: "damme", hash: "x" });
      await new Promise((r) => setTimeout(r, 50));
      expect(listener).not.toHaveBeenCalled();

      await db.countEntries.put({
        id: "e1",
        sessionId: "s1",
        articleId: "a1",
        locationId: "l1",
        quantity: 1,
        counted: true,
        countedAt: null,
        note: null,
        resolution: "COUNTED",
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(listener).toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
