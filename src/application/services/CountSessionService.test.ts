import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService, SessionIncompleteError } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import type { Article, Office } from "../../domain/types";

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: null,
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
  baseDate: "2026-09-01",
  locations: [1, 2, 3, 4, 5].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n as 1 | 2 | 3 | 4 | 5,
    name: `Locatie ${n}`,
  })),
};

describe("CountSessionService", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    await repository.saveOffice(office);
    await repository.saveArticles([
      makeArticle({ articleNumber: "M1", countPeriod: "MONTHLY" }),
      makeArticle({ articleNumber: "M2", countPeriod: "MONTHLY" }),
      makeArticle({ articleNumber: "Q1", countPeriod: "QUARTERLY" }),
      makeArticle({ articleNumber: "Y1", countPeriod: "YEARLY" }),
      makeArticle({ articleNumber: "N1", countPeriod: "NOT_APPLICABLE" }),
    ]);
  });

  it("previewScopes toont het juiste aantal artikelen per sessietype", async () => {
    const previews = await sessionService.previewScopes("office-1");
    const byType = Object.fromEntries(previews.map((p) => [p.sessionType, p.articleCount]));
    expect(byType.MONTHLY).toBe(2);
    expect(byType.QUARTERLY).toBe(3);
    expect(byType.YEARLY).toBe(4);
    expect(byType.FULL).toBe(5);
  });

  it("startSession bewaart de juiste scope op de sessie", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    expect(session.status).toBe("ACTIVE");
    expect(session.articleIds.sort()).toEqual(["office-1:M1", "office-1:M2"].sort());
  });

  it("hergebruikt een actieve sessie in plaats van er een tweede te starten", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    const second = await sessionService.startSession("office-1", "YEARLY");
    expect(second.id).toBe(first.id);
    expect(second.type).toBe("MONTHLY");
  });

  it("genereert bij een volgende sessie meteen entries voor gekende locaties (geleerd via CountingService)", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    // M2 moet ook geteld zijn, anders is de sessie niet afrondbaar (spec v0.2 §4).
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 1,
    });
    await sessionService.completeSession(first.id);

    const second = await sessionService.startSession("office-1", "MONTHLY");
    const entries = await repository.getCountEntries(second.id);
    const entryForM1 = entries.find((e) => e.articleId === "office-1:M1");
    expect(entryForM1).toBeDefined();
    expect(entryForM1?.counted).toBe(false);
    expect(entryForM1?.locationId).toBe(office.locations[0].id);
  });

  it("genereert stub-entries op ALLE gekende locaties wanneer een artikel op meerdere locaties geleerd is", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M1",
      locationId: office.locations[2].id,
      quantity: 5,
    });
    // M2 moet ook geteld zijn, anders is de sessie niet afrondbaar (spec v0.2 §4).
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 1,
    });
    await sessionService.completeSession(first.id);

    const second = await sessionService.startSession("office-1", "MONTHLY");
    const entries = (await repository.getCountEntries(second.id)).filter(
      (e) => e.articleId === "office-1:M1",
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.counted === false)).toBe(true);
    expect(entries.map((e) => e.locationId).sort()).toEqual(
      [office.locations[0].id, office.locations[2].id].sort(),
    );
  });

  it("weigert af te ronden zolang niet alle scope-artikelen (volledig) geteld zijn", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    // M2 blijft ongeteld.
    await expect(sessionService.completeSession(session.id)).rejects.toThrow(
      SessionIncompleteError,
    );

    const stillActive = await repository.getSession(session.id);
    expect(stillActive?.status).toBe("ACTIVE");
    expect(stillActive?.completedAt).toBeNull();
  });

  it("zet status op COMPLETED en vult completedAt zodra alles geteld is", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 0,
    });

    await sessionService.completeSession(session.id);

    const completed = await repository.getSession(session.id);
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.completedAt).not.toBeNull();
    expect(new Date(completed!.completedAt as string).toString()).not.toBe("Invalid Date");
  });

  it("blijft raadpleegbaar via getSessionsForOffice nadat een sessie afgerond is", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 0,
    });
    await sessionService.completeSession(session.id);

    const sessions = await sessionService.getSessionsForOffice("office-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("COMPLETED");
  });
});
