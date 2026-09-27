import { beforeEach, describe, expect, it } from "vitest";
import {
  ComparisonNotAvailableError,
  ComparisonOfficeMismatchError,
  ComparisonService,
  ComparisonSessionNotFoundError,
} from "./ComparisonService";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { ProductCategoryService } from "./ProductCategoryService";
import type { Article, Office } from "../../domain/types";

/**
 * Sprint 3 — Vergelijking tussen stocktellingen. Zelfde patroon als
 * `AnalysisService.test.ts`: de ECHTE services (`CountSessionService`/
 * `CountingService`) bouwen de sessies/snapshots op, nooit handgeschreven
 * `FinalizedSessionResult`-fixtures — zo test dit bestand `ComparisonService`
 * tegen exact het soort bevroren data dat de app ook echt produceert.
 */

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `${overrides.officeId ?? "office-1"}:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "A1",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
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

const office: Office = {
  id: "office-1",
  name: "Lokeren",
  baseDate: "2026-09-01",
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
};

const office2: Office = {
  id: "office-2",
  name: "Gent",
  baseDate: "2026-09-01",
  locations: [{ id: "office-2:loc-1", officeId: "office-2", number: 1, name: "Rek 1", active: true }],
};

describe("ComparisonService", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;
  let comparisonService: ComparisonService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    comparisonService = new ComparisonService(repository, new ProductCategoryService(repository));
    await repository.saveOffice(office);
    await repository.saveOffice(office2);
    await repository.saveArticles([makeArticle({ articleNumber: "A1", costPrice: 10 })]);
  });

  async function completeSession(quantity: number) {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity,
    });
    await countingService.completeLocation(session.id, "office-1:loc-1");
    await sessionService.completeSession(session.id);
    // Sessies vlak na elkaar afronden (zoals in deze test) kan anders
    // identieke `startedAt`/`completedAt`-timestamps opleveren — een kleine,
    // echte vertraging garandeert een ondubbelzinnige chronologische
    // volgorde, nodig voor de "onmiddellijk voorafgaande telling"-tests.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return session;
  }

  it("gooit ComparisonSessionNotFoundError voor een onbestaande sessie", async () => {
    const sessionB = await completeSession(5);
    await expect(comparisonService.compareSessions("does-not-exist", sessionB.id)).rejects.toBeInstanceOf(
      ComparisonSessionNotFoundError,
    );
  });

  it("gooit ComparisonOfficeMismatchError wanneer A en B van verschillende kantoren zijn", async () => {
    const sessionA = await completeSession(3);
    await repository.saveArticles([makeArticle({ articleNumber: "B1", officeId: "office-2" })]);
    const otherOfficeSession = await sessionService.startSession("office-2", "MONTHLY");
    await countingService.recordCount({
      session: otherOfficeSession,
      articleId: "office-2:B1",
      locationId: "office-2:loc-1",
      quantity: 1,
    });
    await countingService.completeLocation(otherOfficeSession.id, "office-2:loc-1");
    await sessionService.completeSession(otherOfficeSession.id);

    await expect(comparisonService.compareSessions(sessionA.id, otherOfficeSession.id)).rejects.toBeInstanceOf(
      ComparisonOfficeMismatchError,
    );
  });

  it("legacy-sessie (geen FinalizedSessionResult): uitgesloten uit getComparisonOptions, en compareSessions gooit ComparisonNotAvailableError", async () => {
    const legacySession = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session: legacySession,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 3,
    });
    // Simuleert een sessie COMPLETED vóór de data-integriteit-sprint (legacy pad).
    await repository.completeSession(legacySession.id);

    const recentSession = await completeSession(8);

    const { sessions, hasLegacySessions } = await comparisonService.getComparisonOptions("office-1");
    expect(hasLegacySessions).toBe(true);
    expect(sessions.map((s) => s.sessionId)).not.toContain(legacySession.id);
    expect(sessions.map((s) => s.sessionId)).toContain(recentSession.id);

    await expect(comparisonService.compareSessions(legacySession.id, recentSession.id)).rejects.toBeInstanceOf(
      ComparisonNotAvailableError,
    );
  });

  it("getDefaultSelection kiest B = geopende sessie, A = onmiddellijk voorafgaande bruikbare telling", async () => {
    const first = await completeSession(3);
    const second = await completeSession(5);
    const third = await completeSession(7);

    const selection = await comparisonService.getDefaultSelection("office-1", third.id);
    expect(selection.sessionIdB).toBe(third.id);
    expect(selection.sessionIdA).toBe(second.id);

    const selectionForFirst = await comparisonService.getDefaultSelection("office-1", first.id);
    expect(selectionForFirst.sessionIdA).toBeNull(); // geen eerdere bruikbare telling
  });

  it("een latere kostprijs-/classificatiewijziging op het levende artikel raakt een reeds vastgelegde vergelijking nooit (historische onveranderlijkheid)", async () => {
    const sessionA = await completeSession(4); // €40
    const sessionB = await completeSession(9); // €90

    const before = await comparisonService.compareSessions(sessionA.id, sessionB.id);
    expect(before.kpis.stockValue.valueA).toBe(40);
    expect(before.kpis.stockValue.valueB).toBe(90);

    const [liveArticle] = await repository.getArticles("office-1");
    await repository.saveArticles([
      { ...liveArticle, costPrice: 999, productGroup: "Nieuwe groep", stockClassification: "OBSOLETE" },
    ]);

    const after = await comparisonService.compareSessions(sessionA.id, sessionB.id);
    expect(after).toEqual(before);
    expect(after.kpis.stockValue.valueA).toBe(40);
    expect(after.kpis.stockValue.valueB).toBe(90);
    expect(after.articles[0].classificationB).toBe("ACTIVE");
  });

  it("een latere canonieke Productgamma-herclassificatie werkt WEL retroactief door in een reeds vastgelegde vergelijking (spec §11/§12)", async () => {
    const sessionA = await completeSession(4);
    const sessionB = await completeSession(9);

    const before = await comparisonService.compareSessions(sessionA.id, sessionB.id);
    // A1 heeft al `productGroup: "GROEP"` -> de eenmalige migratie (spec §4)
    // heeft dit bij deze EERSTE aanroep al gebootstrapt tot een canonieke
    // "GROEP"-categorie.
    expect(before.articles[0].productCategory).toBe("GROEP");

    const productCategoryService = new ProductCategoryService(repository);
    // `addCategory` geeft de VOLLEDIGE lijst terug (incl. de reeds
    // gemigreerde "GROEP"-categorie) — expliciet op naam opzoeken.
    const batterijen = (await productCategoryService.addCategory("office-1", "Batterijen")).find(
      (c) => c.name === "Batterijen",
    )!;
    await productCategoryService.assignArticles("office-1", ["office-1:A1"], batterijen.id);

    const after = await comparisonService.compareSessions(sessionA.id, sessionB.id);
    expect(after.articles[0].productCategory).toBe("Batterijen");
    expect(after.articles[0].productCategoryId).toBe(batterijen.id);
    // Bevroren hoeveelheid/waarde blijven exact ongewijzigd — enkel de groepering verandert.
    expect(after.kpis.stockValue.valueA).toBe(before.kpis.stockValue.valueA);
    expect(after.kpis.stockValue.valueB).toBe(before.kpis.stockValue.valueB);
  });
});
