import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { AppDatabase } from "./db";
import { IndexedDbCountingRepository } from "./IndexedDbCountingRepository";
import { ImportService } from "../../application/services/ImportService";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import type { StockSource } from "../../application/ports/StockSource";
import type { Article, Office } from "../../domain/types";

/**
 * v0.1.1-slotcontrole: herimport van een kantoor terwijl er al
 * locatienamen, ArticleLocationAssignments en een actieve sessie met
 * entries bestaan. Dit test bewust de ECHTE `IndexedDbCountingRepository`
 * (via fake-indexeddb), niet de in-memory testdouble, samen met alle drie
 * de services zoals de UI ze ook gebruikt — zodat we het hele pad
 * ImportService -> CountSessionService -> CountingService -> Dexie dekken.
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

function makeOffice(locationNames: string[] = []): Office {
  return {
    id: "antwerpen",
    name: "Antwerpen",
    baseDate: "2026-08-28",
    locations: [1, 2, 3, 4, 5].map((n, i) => ({
      id: `antwerpen:loc-${n}`,
      officeId: "antwerpen",
      number: n as 1 | 2 | 3 | 4 | 5,
      name: locationNames[i]?.trim() ? locationNames[i] : `Locatie ${n}`,
    })),
  };
}

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
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
    ...overrides,
  };
}

describe("Herimport van een kantoor met bestaande locatienamen, assignments en een actieve sessie", () => {
  let repository: IndexedDbCountingRepository;
  let importService: ImportService;
  let sessionService: CountSessionService;
  let countingService: CountingService;

  beforeEach(() => {
    // Eigen databasenaam per test, zodat tests elkaar niet raken — zie
    // IndexedDbCountingRepository.test.ts voor hetzelfde patroon.
    const db = new AppDatabase(`reimport-test-${Math.random()}`);
    repository = new IndexedDbCountingRepository(db);
    importService = new ImportService(repository);
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
  });

  it("bewaart locatienamen, assignments, actieve sessie en entries; update wel de artikelmasterdata", async () => {
    // 1) Eerste import: A1, A2, A3.
    const firstSource = new FakeStockSource(
      makeOffice(),
      [makeArticle("A1"), makeArticle("A2"), makeArticle("A3")],
      "antwerpen-v1.xlsx",
    );
    await importService.commitImport(await importService.prepareImport(firstSource));

    // 2) Gebruiker past locatienamen aan (zoals SettingsPage doet: direct
    // via repository.saveOffice met de bijgewerkte locations-array).
    const officeAfterRename = await repository.getOffice("antwerpen");
    if (!officeAfterRename) throw new Error("kantoor niet gevonden");
    officeAfterRename.locations[1] = { ...officeAfterRename.locations[1], name: "Buitenmagazijn" };
    officeAfterRename.locations[2] = { ...officeAfterRename.locations[2], name: "Koelcel" };
    await repository.saveOffice(officeAfterRename);

    // 3) Een maandtelling starten en twee tellingen registreren — dit leert
    // meteen de ArticleLocationAssignments (spec §9).
    const session = await sessionService.startSession("antwerpen", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "antwerpen:A1",
      locationId: "antwerpen:loc-1",
      quantity: 5,
    });
    await countingService.recordCount({
      session,
      articleId: "antwerpen:A3",
      locationId: "antwerpen:loc-3",
      quantity: 0,
    });

    const sessionBefore = await repository.getSession(session.id);
    const entriesBefore = await repository.getCountEntries(session.id);
    const assignmentsBefore = await repository.getArticleLocationAssignments("antwerpen");
    expect(sessionBefore?.status).toBe("ACTIVE");
    expect(entriesBefore).toHaveLength(2);
    expect(assignmentsBefore).toHaveLength(2);

    // 4) Herimport van hetzelfde kantoor: A3 verdwijnt uit het nieuwe
    // bestand, A1 heeft nieuwe masterdata (andere kostprijs/omschrijving),
    // A2 blijft ongewijzigd, A4 is nieuw.
    const secondSource = new FakeStockSource(
      makeOffice(["Nieuwe naam die genegeerd moet worden", "Ook genegeerd"]),
      [
        makeArticle("A1", { costPrice: 99.5, description: "Artikel A1 (bijgewerkt)" }),
        makeArticle("A2"),
        makeArticle("A4"),
      ],
      "antwerpen-v2.xlsx",
    );
    const preview = await importService.prepareImport(secondSource);
    expect(preview.existing).not.toBeNull(); // moet gedetecteerd worden, niet stilletjes overschrijven
    await importService.commitImport(preview);

    // --- Locatienamen: NIET overschreven door de nieuwe Excel ---
    const officeAfterReimport = await repository.getOffice("antwerpen");
    expect(officeAfterReimport?.locations[1].name).toBe("Buitenmagazijn");
    expect(officeAfterReimport?.locations[2].name).toBe("Koelcel");

    // --- ArticleLocationAssignments: ongewijzigd, ook die voor het
    // verdwenen artikel A3 ---
    const assignmentsAfter = await repository.getArticleLocationAssignments("antwerpen");
    expect(assignmentsAfter).toHaveLength(2);
    expect(assignmentsAfter.find((a) => a.articleId === "antwerpen:A3")).toBeDefined();
    expect(assignmentsAfter.find((a) => a.articleId === "antwerpen:A3")?.active).toBe(true);

    // --- Actieve sessie: bestaat nog, ongewijzigde scope ---
    const sessionAfter = await repository.getSession(session.id);
    expect(sessionAfter?.status).toBe("ACTIVE");
    expect(sessionAfter?.articleIds.sort()).toEqual(sessionBefore?.articleIds.sort());

    // --- CountEntries: exact ongewijzigd, ook die van het verdwenen A3 ---
    const entriesAfter = await repository.getCountEntries(session.id);
    expect(entriesAfter).toHaveLength(2);
    for (const before of entriesBefore) {
      const after = entriesAfter.find((e) => e.id === before.id);
      expect(after).toEqual(before);
    }

    // --- Artikelmasterdata: A1 is wél bijgewerkt vanuit de nieuwe Excel ---
    const articles = await repository.getArticles("antwerpen");
    const a1 = articles.find((a) => a.id === "antwerpen:A1");
    expect(a1?.costPrice).toBe(99.5);
    expect(a1?.description).toBe("Artikel A1 (bijgewerkt)");

    // --- A3 (niet meer in het nieuwe bestand) blijft gewoon bestaan i.p.v.
    // verwijderd te worden — dit is net wat historische tellingen leesbaar
    // houdt (zie test hieronder voor de expliciete controle daarvan) ---
    const a3 = articles.find((a) => a.id === "antwerpen:A3");
    expect(a3).toBeDefined();

    // --- A4 is nieuw toegevoegd ---
    expect(articles.find((a) => a.id === "antwerpen:A4")).toBeDefined();
  });

  it("een artikel dat bij een latere import verdwijnt, breekt de historische telling niet", async () => {
    const firstSource = new FakeStockSource(makeOffice(), [makeArticle("A1"), makeArticle("A3")], "v1.xlsx");
    await importService.commitImport(await importService.prepareImport(firstSource));

    const session = await sessionService.startSession("antwerpen", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "antwerpen:A3",
      locationId: "antwerpen:loc-3",
      quantity: 12,
    });
    // A1 moet ook geteld zijn, anders is de sessie niet afrondbaar (spec v0.2 §4).
    await countingService.recordCount({
      session,
      articleId: "antwerpen:A1",
      locationId: "antwerpen:loc-1",
      quantity: 4,
    });
    await sessionService.completeSession(session.id);

    // Nieuwe import zonder A3.
    const secondSource = new FakeStockSource(makeOffice(), [makeArticle("A1")], "v2.xlsx");
    await importService.commitImport(await importService.prepareImport(secondSource));

    // De historische sessie en entry blijven perfect raadpleegbaar.
    const historicalSession = await repository.getSession(session.id);
    expect(historicalSession?.status).toBe("COMPLETED");
    expect(historicalSession?.articleIds).toContain("antwerpen:A3");

    const historicalEntries = await repository.getCountEntries(session.id);
    const a3Entry = historicalEntries.find((e) => e.articleId === "antwerpen:A3");
    expect(a3Entry).toBeDefined();
    expect(a3Entry?.quantity).toBe(12);
    expect(a3Entry?.counted).toBe(true);

    // En het artikel zelf is nog steeds opvraagbaar (nodig om de historische
    // regel in de UI te tonen — omschrijving, artikelnummer, enz.), ook al
    // staat het niet meer in de nieuwste Excel-import.
    const articles = await repository.getArticles("antwerpen");
    const a3 = articles.find((a) => a.id === "antwerpen:A3");
    expect(a3).toBeDefined();
    expect(a3?.articleNumber).toBe("A3");
  });
});
