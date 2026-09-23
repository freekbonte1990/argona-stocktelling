import "fake-indexeddb/auto";
import Dexie, { type Table } from "dexie";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "./db";
import { IndexedDbCountingRepository } from "./IndexedDbCountingRepository";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * Data-integriteit-sprint §10: Dexie-migraties moeten strikt additief zijn —
 * geen dataverlies, geen crash. Deze test bouwt een database op met UITSLUITEND
 * het OUDE schema (versies 1-4, vóór `finalizedSessionResults` bestond — v0.2.1/
 * v0.3-vorm), precies zoals een bestaande installatie die nog niet geüpgraded
 * is. Daarna wordt diezelfde database (zelfde naam) geopend met de HUIDIGE
 * `AppDatabase` (versies 1-5) — Dexie voert dan zelf de upgrade uit.
 */

const OLD_SCHEMA_DB_NAME = "argona-stocktelling-migration-test";

class OldSchemaDatabase extends Dexie {
  offices!: Table<Office, string>;
  articles!: Table<Article, string>;
  sessions!: Table<CountSession, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      offices: "id",
      articles: "id, officeId",
      sessions: "id, officeId, status",
      countEntries: "id, sessionId, articleId, locationId",
      assignments: "id, officeId, articleId, locationId, [officeId+locationId]",
      importMeta: "officeId",
    });
    this.version(2).stores({ appState: "id" });
    this.version(3).stores({
      locationSessionStatuses: "id, sessionId, locationId, [sessionId+locationId]",
    });
    this.version(4).stores({
      historicalSheets: "id, officeId, sessionId",
      stockHistoryEntries: "id, officeId, articleId, sessionName",
    });
  }
}

const office: Office = {
  id: "office-1",
  name: "Gent",
  baseDate: "2026-06-01",
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
};

const article: Article = {
  id: "office-1:A1",
  officeId: "office-1",
  articleNumber: "A1",
  officialArticleNumber: "A1",
  idType: "OFFICIEEL",
  description: "Bestaand artikel",
  productGroup: "GROEP",
  supplier: null,
  unit: "stuk",
  costPrice: 3,
  rawCountPeriod: "MAAND",
  countPeriod: "MONTHLY",
  rawStatus: "ACTIEF",
  status: "ACTIVE",
  previousCount: 7,
  sourceRow: 1,
};

const oldCompletedSession: CountSession = {
  id: "session-old-1",
  officeId: "office-1",
  type: "MONTHLY",
  status: "COMPLETED",
  startedAt: "2026-06-01T08:00:00.000Z",
  completedAt: "2026-06-30T15:00:00.000Z",
  sourceFileName: "Gent_standaard.xlsx",
  sourceBaseDate: "2026-06-01",
  articleIds: ["office-1:A1"],
  // Bewust GEEN locationIds — precies zoals een sessie van vóór data-integriteit-sprint §5.
};

describe("Dexie-schemamigratie (data-integriteit-sprint §10)", () => {
  it("een bestaande v0.2.1/v0.3-database (versies 1-4) upgradet naar v5 zonder dataverlies of crash", async () => {
    // --- Stap 1: de "oude" database opbouwen, met enkel het oude schema. ---
    const oldDb = new OldSchemaDatabase(OLD_SCHEMA_DB_NAME);
    await oldDb.open();
    await oldDb.table("offices").put(office);
    await oldDb.table("articles").put(article);
    await oldDb.table("sessions").put(oldCompletedSession);
    oldDb.close();

    // --- Stap 2: dezelfde database (zelfde naam) openen met het HUIDIGE schema. ---
    const upgradedDb = new AppDatabase(OLD_SCHEMA_DB_NAME);
    const repository = new IndexedDbCountingRepository(upgradedDb);

    // Alle oude data moet gewoon intact en leesbaar blijven.
    const loadedOffice = await repository.getOffice("office-1");
    expect(loadedOffice?.name).toBe("Gent");
    const loadedArticles = await repository.getArticles("office-1");
    expect(loadedArticles).toHaveLength(1);
    expect(loadedArticles[0].previousCount).toBe(7);
    const loadedSession = await repository.getSession("session-old-1");
    expect(loadedSession?.status).toBe("COMPLETED");
    expect(loadedSession?.locationIds).toBeUndefined(); // backward-compatible: nooit gezet, nooit een crash.

    // De NIEUWE tabel bestaat en is gewoon leeg/undefined voor deze oude sessie
    // (nooit gefinaliseerd onder de nieuwe code) — geen crash, `ExportService`
    // valt hierop terug op haar legacy-pad.
    const finalized = await repository.getFinalizedSessionResult("session-old-1");
    expect(finalized).toBeUndefined();

    // De nieuwe tabel is ook gewoon bruikbaar voor NIEUWE schrijfacties.
    await repository.saveOffice(office); // sanity: bestaande writes blijven werken.
    upgradedDb.close();
  });
});
