import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "./db";
import { IndexedDbCountingRepository } from "./IndexedDbCountingRepository";
import { ImportService } from "../../application/services/ImportService";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import type { StockSource } from "../../application/ports/StockSource";
import type { Article, Office } from "../../domain/types";

/**
 * v0.1.1-slotcontrole, punt 3: simuleert de volledige workflow uit de
 * opdracht (import -> maandtelling -> tellen op quantity 0 en 12, over twee
 * locaties -> "refresh" -> "browser sluiten/openen" -> telling hervatten) en
 * controleert dat alles bewaard blijft.
 *
 * Een echte klik-voor-klik browsertest was vanuit deze omgeving niet
 * uitvoerbaar: de dev-server zou moeten draaien op de shell waar Claude's
 * device-bash-tool werkt, maar de browserpane van de gebruiker kan die
 * localhost-server niet bereiken (ze draaien niet op hetzelfde netwerk).
 * Dit is het diepst mogelijke geautomatiseerde equivalent: het test de
 * ECHTE opslaglaag (Dexie/IndexedDB via fake-indexeddb) die de UI's
 * live-queries en autosave/herstel-gedrag voedt, met twee onafhankelijke
 * databaseverbindingen om "sluiten en heropenen" na te bootsen — Dexie
 * bewaart niets in geheugen tussen twee afzonderlijke connecties, dus een
 * tweede connectie die alles teruglezen kan is het functionele equivalent
 * van een browser-refresh/herstart.
 */

class FakeStockSource implements StockSource {
  readonly sourceLabel: string;
  private readonly office: Office;
  private readonly articles: Article[];

  constructor(office: Office, articles: Article[], sourceLabel: string) {
    this.office = office;
    this.articles = articles;
    this.sourceLabel = sourceLabel;
  }

  async loadOffice(): Promise<Office> {
    return this.office;
  }
  async loadArticles(): Promise<Article[]> {
    return this.articles;
  }
}

function makeOffice(): Office {
  return {
    id: "antwerpen",
    name: "Antwerpen",
    baseDate: "2026-08-28",
    locations: [1, 2, 3, 4, 5].map((n) => ({
      id: `antwerpen:loc-${n}`,
      officeId: "antwerpen",
      number: n,
      name: `Locatie ${n}`,
      active: true,
    })),
  };
}

function makeArticle(articleNumber: string): Article {
  return {
    id: `antwerpen:${articleNumber}`,
    officeId: "antwerpen",
    articleNumber,
    officialArticleNumber: articleNumber,
    idType: "OFFICIEEL",
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "STUKS",
    costPrice: 10,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
  };
}

describe("Volledige workflow overleeft refresh + browser sluiten/heropenen", () => {
  it("import, maandtelling, tellen op twee locaties, twee databaseverbindingen na elkaar", async () => {
    const dbName = `workflow-test-${Math.random()}`;

    // --- Sessie 1: "eerste browsersessie" ---
    const db1 = new AppDatabase(dbName);
    const repo1 = new IndexedDbCountingRepository(db1);
    const importService1 = new ImportService(repo1);
    const sessionService1 = new CountSessionService(repo1);
    const countingService1 = new CountingService(repo1);

    // 1) Kantoor importeren.
    const source = new FakeStockSource(
      makeOffice(),
      [makeArticle("A1"), makeArticle("A2")],
      "antwerpen.xlsx",
    );
    await importService1.commitImport(await importService1.prepareImport(source));

    // 2) Maandtelling starten.
    const session = await sessionService1.startSession("antwerpen", "MONTHLY");
    expect(session.status).toBe("ACTIVE");

    // 3) Hoeveelheid 0 als geteld opslaan voor A1 op locatie 1.
    await countingService1.recordCount({
      session,
      articleId: "antwerpen:A1",
      locationId: "antwerpen:loc-1",
      quantity: 0,
    });

    // 4) Ander artikel (A2) op 12 zetten, op locatie 2.
    await countingService1.recordCount({
      session,
      articleId: "antwerpen:A2",
      locationId: "antwerpen:loc-2",
      quantity: 12,
    });

    // 5) Datzelfde artikel (A2) ook op een tweede locatie tellen (locatie 4).
    await countingService1.recordCount({
      session,
      articleId: "antwerpen:A2",
      locationId: "antwerpen:loc-4",
      quantity: 3,
    });

    // 6) "Refresh": binnen dezelfde browsersessie opnieuw uitlezen (zoals een
    // live-query na een React-rerender zou doen) — moet meteen alles tonen.
    const entriesAfterRefresh = await repo1.getCountEntries(session.id);
    expect(entriesAfterRefresh).toHaveLength(3);

    // De Dexie-verbinding sluiten simuleert het sluiten van de browser/tab.
    db1.close();

    // --- Sessie 2: "browser opnieuw geopend" — nieuwe, onafhankelijke
    // Dexie-verbinding naar dezelfde onderliggende IndexedDB-database ---
    const db2 = new AppDatabase(dbName);
    const repo2 = new IndexedDbCountingRepository(db2);
    const sessionService2 = new CountSessionService(repo2);

    // 7) Telling hervatten: de app leidt het startscherm/actieve sessie af
    // uit wat in IndexedDB staat (App.tsx), niet uit React-state.
    const resumedOffice = await repo2.getOffice("antwerpen");
    const resumedSession = await sessionService2.getActiveSession("antwerpen");
    expect(resumedOffice?.name).toBe("Antwerpen");
    expect(resumedSession?.id).toBe(session.id);
    expect(resumedSession?.status).toBe("ACTIVE");

    // 8) Alles blijft behouden: alle drie de tellingen, met correcte
    // quantity/counted-combinaties (incl. de geldige nul-telling).
    const entriesAfterReopen = await repo2.getCountEntries(session.id);
    expect(entriesAfterReopen).toHaveLength(3);

    const a1Entry = entriesAfterReopen.find(
      (e) => e.articleId === "antwerpen:A1" && e.locationId === "antwerpen:loc-1",
    );
    expect(a1Entry?.quantity).toBe(0);
    expect(a1Entry?.counted).toBe(true);

    const a2AtLoc2 = entriesAfterReopen.find(
      (e) => e.articleId === "antwerpen:A2" && e.locationId === "antwerpen:loc-2",
    );
    expect(a2AtLoc2?.quantity).toBe(12);
    expect(a2AtLoc2?.counted).toBe(true);

    const a2AtLoc4 = entriesAfterReopen.find(
      (e) => e.articleId === "antwerpen:A2" && e.locationId === "antwerpen:loc-4",
    );
    expect(a2AtLoc4?.quantity).toBe(3);
    expect(a2AtLoc4?.counted).toBe(true);

    // De geleerde locatiekoppelingen (A1@loc-1, A2@loc-2, A2@loc-4) zijn er ook nog.
    const assignments = await repo2.getArticleLocationAssignments("antwerpen");
    expect(assignments).toHaveLength(3);
    expect(assignments.filter((a) => a.articleId === "antwerpen:A2")).toHaveLength(2);

    db2.close();
  });
});
