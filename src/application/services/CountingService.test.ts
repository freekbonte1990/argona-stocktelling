import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import type { Article, CountSession, Office } from "../../domain/types";

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: "TIJDELIJK",
    description: "Test",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 1,
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
  name: "Antwerpen",
  baseDate: null,
  locations: [1, 2, 3, 4, 5].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n,
    name: `Locatie ${n}`,
    active: true,
  })),
};

describe("CountingService", () => {
  let repository: InMemoryCountingRepository;
  let countingService: CountingService;
  let sessionService: CountSessionService;
  let session: CountSession;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    await repository.saveOffice(office);
    await repository.saveArticles([
      makeArticle({ articleNumber: "TMP-DAM-0001" }),
      makeArticle({ articleNumber: "M2" }),
    ]);
    session = await sessionService.startSession("office-1", "MONTHLY");
  });

  it("accepteert tijdelijke artikelnummers zoals TMP-DAM-0001 als geldig artikel-ID", async () => {
    const entry = await countingService.recordCount({
      session,
      articleId: "office-1:TMP-DAM-0001",
      locationId: office.locations[0].id,
      quantity: 5,
    });
    expect(entry.articleId).toBe("office-1:TMP-DAM-0001");
    expect(entry.counted).toBe(true);
  });

  it("quantity=0 resulteert in counted=true (geldige nulteling, niet 'niet geteld')", async () => {
    const entry = await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 0,
    });
    expect(entry.quantity).toBe(0);
    expect(entry.counted).toBe(true);
  });

  it("maakt bij het tellen een ArticleLocationAssignment aan (locatie leren)", async () => {
    await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: office.locations[2].id,
      quantity: 7,
    });
    const assignments = await repository.getArticleLocationAssignments("office-1");
    const assignment = assignments.find(
      (a) => a.articleId === "office-1:M2" && a.locationId === office.locations[2].id,
    );
    expect(assignment).toBeDefined();
    expect(assignment?.active).toBe(true);
  });

  it("een artikel kan aan meerdere locaties gekoppeld worden", async () => {
    await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 1,
    });
    await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: office.locations[1].id,
      quantity: 2,
    });
    const assignments = await repository.getArticleLocationAssignments("office-1");
    const forM2 = assignments.filter((a) => a.articleId === "office-1:M2");
    expect(forM2.map((a) => a.locationId).sort()).toEqual(
      [office.locations[0].id, office.locations[1].id].sort(),
    );

    const entries = await repository.getCountEntries(session.id);
    const entriesForM2 = entries.filter((e) => e.articleId === "office-1:M2");
    expect(entriesForM2).toHaveLength(2);
  });

  describe("expliciet afwezig (v0.2.1 §5)", () => {
    it("confirmAbsent slaat een geldige nulteling op zonder fictieve locatie", async () => {
      const entry = await countingService.confirmAbsent(session, "office-1:M2");
      expect(entry.locationId).toBeNull();
      expect(entry.quantity).toBe(0);
      expect(entry.counted).toBe(true);
      expect(entry.resolution).toBe("CONFIRMED_ABSENT");

      const entries = await repository.getCountEntries(session.id);
      const stored = entries.find((e) => e.articleId === "office-1:M2");
      expect(stored).toEqual(entry);

      // Geen ArticleLocationAssignment aangemaakt voor een niet-aangetroffen artikel.
      const assignments = await repository.getArticleLocationAssignments("office-1");
      expect(assignments.find((a) => a.articleId === "office-1:M2")).toBeUndefined();
    });

    it("confirmAllAbsent bevestigt meerdere artikelen tegelijk", async () => {
      const entries = await countingService.confirmAllAbsent(session, [
        "office-1:TMP-DAM-0001",
        "office-1:M2",
      ]);
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.resolution === "CONFIRMED_ABSENT")).toBe(true);
      expect(entries.every((e) => e.locationId === null)).toBe(true);

      const stored = await repository.getCountEntries(session.id);
      expect(stored).toHaveLength(2);
    });

    it("een normale telling en een expliciete afwezig-telling worden nooit verward", async () => {
      await countingService.recordCount({
        session,
        articleId: "office-1:TMP-DAM-0001",
        locationId: office.locations[0].id,
        quantity: 3,
      });
      await countingService.confirmAbsent(session, "office-1:M2");

      const entries = await repository.getCountEntries(session.id);
      const counted = entries.find((e) => e.articleId === "office-1:TMP-DAM-0001");
      const absent = entries.find((e) => e.articleId === "office-1:M2");
      expect(counted?.resolution).toBe("COUNTED");
      expect(counted?.locationId).toBe(office.locations[0].id);
      expect(absent?.resolution).toBe("CONFIRMED_ABSENT");
      expect(absent?.locationId).toBeNull();
    });
  });

  describe("vaste locatie aanpassen vanuit artikeldetail (v0.2.1 §6)", () => {
    it("een locatie toevoegen aan een artikel via ArticleLocationAssignment (los van tellen)", async () => {
      await repository.saveArticleLocationAssignment({
        id: `office-1:office-1:M2:${office.locations[3].id}`,
        officeId: "office-1",
        articleId: "office-1:M2",
        locationId: office.locations[3].id,
        active: true,
        lastSeenAt: new Date().toISOString(),
      });
      const assignments = await repository.getArticleLocationAssignments("office-1");
      const assignment = assignments.find(
        (a) => a.articleId === "office-1:M2" && a.locationId === office.locations[3].id,
      );
      expect(assignment?.active).toBe(true);
    });

    it("een locatie verwijderen van een artikel deactiveert de koppeling (geen hard delete)", async () => {
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 3,
      });
      // Vanuit de artikeldetailpagina: "Verwijderen" zet active op false,
      // de koppeling zelf blijft bestaan (historische tellingen blijven correct).
      await repository.saveArticleLocationAssignment({
        id: `office-1:office-1:M2:${office.locations[0].id}`,
        officeId: "office-1",
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        active: false,
        lastSeenAt: new Date().toISOString(),
      });
      const assignments = await repository.getArticleLocationAssignments("office-1");
      const assignment = assignments.find(
        (a) => a.articleId === "office-1:M2" && a.locationId === office.locations[0].id,
      );
      expect(assignment?.active).toBe(false);
      // De al gedane telling zelf blijft ongewijzigd staan.
      const entries = await repository.getCountEntries(session.id);
      expect(entries.find((e) => e.articleId === "office-1:M2")?.quantity).toBe(3);
    });
  });

  describe("locatiestatus (v0.2.1 §4)", () => {
    it("een locatie is standaard nog niet aanwezig in getLocationStatuses", async () => {
      const statuses = await countingService.getLocationStatuses(session.id);
      expect(statuses).toHaveLength(0);
    });

    it("completeLocation zet een locatie op COMPLETED met completedAt", async () => {
      await countingService.completeLocation(session.id, office.locations[0].id);

      const statuses = await countingService.getLocationStatuses(session.id);
      const status = statuses.find((s) => s.locationId === office.locations[0].id);
      expect(status?.status).toBe("COMPLETED");
      expect(status?.completedAt).not.toBeNull();
    });

    it("reopenLocation zet een afgeronde locatie terug op OPEN", async () => {
      await countingService.completeLocation(session.id, office.locations[0].id);
      await countingService.reopenLocation(session.id, office.locations[0].id);

      const statuses = await countingService.getLocationStatuses(session.id);
      const status = statuses.find((s) => s.locationId === office.locations[0].id);
      expect(status?.status).toBe("OPEN");
      expect(status?.completedAt).toBeNull();
    });

    it("locatiestatus is per sessie+locatie onafhankelijk van andere locaties", async () => {
      await countingService.completeLocation(session.id, office.locations[0].id);

      const statuses = await countingService.getLocationStatuses(session.id);
      const other = statuses.find((s) => s.locationId === office.locations[1].id);
      expect(other).toBeUndefined();
    });
  });

  describe("Review wordt bijgewerkt na tellen vanuit CountingPage (v0.2.1-hotfix §7)", () => {
    it("een artikel zonder bestaande CountEntry verschijnt na tellen als volledig geteld in de review, met bijgewerkte totalen", async () => {
      const before = await sessionService.getReview(session.id);
      const beforeResult = before.results.find((r) => r.articleId === "office-1:M2");
      expect(beforeResult?.fullyCounted).toBe(false);
      expect(before.notCountedArticles).toBeGreaterThan(0);

      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 6,
      });

      const after = await sessionService.getReview(session.id);
      const afterResult = after.results.find((r) => r.articleId === "office-1:M2");
      expect(afterResult?.fullyCounted).toBe(true);
      expect(afterResult?.newTotalCount).toBe(6);
      expect(after.notCountedArticles).toBe(before.notCountedArticles - 1);
    });

    it("'+ Andere locatie' (opnieuw tellen op een tweede locatie) telt op bij het totaal van hetzelfde artikel", async () => {
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 4,
      });
      const afterFirst = await sessionService.getReview(session.id);
      const afterFirstResult = afterFirst.results.find((r) => r.articleId === "office-1:M2");
      expect(afterFirstResult?.newTotalCount).toBe(4);

      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[1].id,
        quantity: 2,
      });
      const afterSecond = await sessionService.getReview(session.id);
      const afterSecondResult = afterSecond.results.find((r) => r.articleId === "office-1:M2");
      expect(afterSecondResult?.newTotalCount).toBe(6);
      expect(afterSecondResult?.fullyCounted).toBe(true);
    });

    it("'Hertellen' op dezelfde locatie overschrijft de vorige hoeveelheid daar, zonder de andere locatie te raken", async () => {
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 4,
      });
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[1].id,
        quantity: 2,
      });

      // Hertellen op locatie 1: 4 -> 9.
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 9,
      });

      const review = await sessionService.getReview(session.id);
      const result = review.results.find((r) => r.articleId === "office-1:M2");
      expect(result?.newTotalCount).toBe(11);
      const perLoc1 = result?.perLocation.find((l) => l.locationId === office.locations[0].id);
      const perLoc2 = result?.perLocation.find((l) => l.locationId === office.locations[1].id);
      expect(perLoc1?.quantity).toBe(9);
      expect(perLoc2?.quantity).toBe(2);
    });
  });
});
