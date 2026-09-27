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
    number: n,
    name: `Locatie ${n}`,
    active: true,
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
      resolution: "COUNTED",
    });

    const active = await repository.getActiveSession("office-1");
    expect(active?.id).toBe("session-1");
    const entries = await repository.getCountEntries("session-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].quantity).toBe(0);
    expect(entries[0].counted).toBe(true);
  });

  describe("Sprint 3.3 §5: deleteSession/deleteHistoricalSnapshot (echte Dexie-transactie, geen InMemory-testdouble)", () => {
    async function seedCompletedSession(sessionId: string, sessionName: string) {
      await repository.saveOffice(office);
      await repository.saveArticles([
        {
          id: "office-1:A1",
          officeId: "office-1",
          articleNumber: "A1",
          officialArticleNumber: null,
          idType: null,
          description: "Artikel A1",
          productGroup: "GROEP",
          supplier: null,
          unit: "stuk",
          costPrice: 1,
          rawCountPeriod: "MAAND",
          countPeriod: "MONTHLY",
          rawStatus: "ACTIEF",
          status: "ACTIVE",
          previousCount: 5,
          sourceRow: 1,
        },
      ]);
      const session = {
        id: sessionId,
        officeId: "office-1",
        type: "MONTHLY" as const,
        status: "COMPLETED" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sourceFileName: "test.xlsx",
        sourceBaseDate: "2026-09-01",
        articleIds: ["office-1:A1"],
      };
      const snapshot = {
        sessionId,
        sessionType: "MONTHLY" as const,
        sessionName,
        snapshotDate: "2026-09-01",
        articles: [
          {
            articleId: "office-1:A1",
            article: (await repository.getArticles("office-1"))[0],
            status: "GETELD" as const,
            totalCount: 5,
            previousCount: 2,
            differenceQuantity: 3,
            costPrice: 1,
            previousValue: 2,
            amount: 5,
            differenceAmount: 3,
            perLocation: [],
            note: null,
          },
        ],
      };
      await repository.finalizeSession({
        session,
        updatedArticles: [{ ...(await repository.getArticles("office-1"))[0], previousCount: 5 }],
        historyEntries: [
          {
            countDate: "2026-09-01",
            sessionType: "MONTHLY",
            sessionName,
            articleId: "office-1:A1",
            articleNumber: "A1",
            description: "Artikel A1",
            totalCount: 5,
            previousCount: 2,
            differenceQuantity: 3,
            costPrice: 1,
            differenceAmount: 3,
            status: "GETELD",
            locationNames: [],
          },
        ],
        review: {
          results: [],
          totals: {
            totalCount: 5,
            totalAmount: 5,
            totalDifferenceQuantity: 3,
            totalDifferenceAmount: 3,
          },
          notCountedArticles: 0,
          allLocationsCompleted: true,
          incompleteActiveLocations: [],
        } as unknown as import("../../domain/review").SessionReviewSummary,
        snapshot,
      });
      await repository.saveHistoricalSheetSnapshot({
        officeId: "office-1",
        sessionId,
        sheetName: sessionName,
        rows: [["A1", 5]],
      });
      return snapshot;
    }

    it("deleteSession verwijdert de sessie, haar entries/statussen/finalized-resultaat/eigen sheet/HISTORIE, en persisteert de meegegeven artikelen", async () => {
      await seedCompletedSession("session-1", "2026-09 Maand");
      await repository.saveCountEntry({
        id: "session-1:office-1:A1:office-1:loc-1",
        sessionId: "session-1",
        articleId: "office-1:A1",
        locationId: "office-1:loc-1",
        quantity: 5,
        counted: true,
        countedAt: new Date().toISOString(),
        note: null,
        resolution: "COUNTED",
      });
      await repository.saveLocationSessionStatus({
        id: "session-1:office-1:loc-1",
        sessionId: "session-1",
        locationId: "office-1:loc-1",
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
      });

      await repository.deleteSession({
        officeId: "office-1",
        sessionId: "session-1",
        sessionName: "2026-09 Maand",
        updatedArticles: [
          { ...(await repository.getArticles("office-1"))[0], previousCount: 2 },
        ],
      });

      expect(await repository.getSession("session-1")).toBeUndefined();
      expect(await repository.getCountEntries("session-1")).toHaveLength(0);
      expect(await repository.getLocationSessionStatuses("session-1")).toHaveLength(0);
      expect(await repository.getFinalizedSessionResult("session-1")).toBeUndefined();
      expect(await repository.getHistoricalSheetSnapshots("office-1")).toHaveLength(0);
      expect(await repository.getStockHistoryEntries("office-1")).toHaveLength(0);

      // Nooit het artikel zelf verwijderd — enkel previousCount teruggedraaid.
      const articles = await repository.getArticles("office-1");
      expect(articles).toHaveLength(1);
      expect(articles[0].previousCount).toBe(2);
    });

    it("deleteSession laat een geïmporteerde sheet met dezelfde naam (andere/geen sessionId) met rust", async () => {
      await seedCompletedSession("session-1", "2026-09 Maand");
      // Overschrijf de sheet met een IMPORT-versie (sessionId: null) —
      // simuleert een naamsbotsing met een geïmporteerd tellingtabblad.
      await repository.saveHistoricalSheetSnapshot({
        officeId: "office-1",
        sessionId: null,
        sheetName: "2026-09 Maand",
        rows: [["geïmporteerd"]],
      });

      await repository.deleteSession({
        officeId: "office-1",
        sessionId: "session-1",
        sessionName: "2026-09 Maand",
        updatedArticles: [],
      });

      const sheets = await repository.getHistoricalSheetSnapshots("office-1");
      expect(sheets).toHaveLength(1);
      expect(sheets[0].sessionId).toBeNull();
    });

    it("deleteHistoricalSnapshot verwijdert enkel de legacy-sheet/HISTORIE, nooit artikelen of andere sessies", async () => {
      await seedCompletedSession("session-1", "2026-09 Maand");
      await repository.saveHistoricalSheetSnapshot({
        officeId: "office-1",
        sessionId: null,
        sheetName: "LEGACY 2025-03",
        rows: [["A1", 3]],
      });
      await repository.saveStockHistoryEntries("office-1", [
        {
          countDate: "2025-03-31",
          sessionType: "FULL",
          sessionName: "LEGACY 2025-03",
          articleId: "office-1:A1",
          articleNumber: "A1",
          description: "Artikel A1",
          totalCount: 3,
          previousCount: null,
          differenceQuantity: null,
          costPrice: 1,
          differenceAmount: null,
          status: "GETELD",
          locationNames: [],
        },
        ...(await repository.getStockHistoryEntries("office-1")),
      ]);

      await repository.deleteHistoricalSnapshot("office-1", "LEGACY 2025-03");

      const sheets = await repository.getHistoricalSheetSnapshots("office-1");
      expect(sheets.map((s) => s.sheetName)).toEqual(["2026-09 Maand"]);
      const history = await repository.getStockHistoryEntries("office-1");
      expect(history.every((h) => h.sessionName !== "LEGACY 2025-03")).toBe(true);
      // De echte app-sessie en haar eigen HISTORIE blijven volledig intact.
      expect(await repository.getSession("session-1")).toBeDefined();
      expect(history.some((h) => h.sessionName === "2026-09 Maand")).toBe(true);
      expect(await repository.getArticles("office-1")).toHaveLength(1);
    });
  });
});
