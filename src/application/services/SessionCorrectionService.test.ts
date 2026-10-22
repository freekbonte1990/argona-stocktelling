import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { SessionCorrectionService, SessionNotCorrectableError } from "./SessionCorrectionService";
import { SessionCorrectionError } from "../../domain/sessionCorrection";
import type { Article, Office } from "../../domain/types";

function makeArticle(articleNumber: string, previousCount: number): Article {
  return {
    id: `office-1:${articleNumber}`,
    officeId: "office-1",
    articleNumber,
    officialArticleNumber: null,
    idType: null,
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount,
    sourceRow: 1,
  };
}

const office: Office = {
  id: "office-1",
  name: "Lokeren",
  baseDate: "2026-09-01",
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
};

describe("SessionCorrectionService", () => {
  let repository: InMemoryCountingRepository;
  let sessions: CountSessionService;
  let counting: CountingService;
  let service: SessionCorrectionService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessions = new CountSessionService(repository);
    counting = new CountingService(repository);
    service = new SessionCorrectionService(repository);
    await repository.saveOffice(office);
    await repository.saveArticles([makeArticle("M1", 5), makeArticle("M2", 5)]);
  });

  async function runCount(m1: number, m2: number): Promise<string> {
    const session = await sessions.startSession("office-1", "MONTHLY");
    await counting.recordCount({ session, articleId: "office-1:M1", locationId: "office-1:loc-1", quantity: m1 });
    await counting.recordCount({ session, articleId: "office-1:M2", locationId: "office-1:loc-1", quantity: m2 });
    await counting.completeLocation(session.id, "office-1:loc-1");
    await sessions.completeSession(session.id);
    return session.id;
  }

  it("corrigeert het aantal; sessie blijft bestaan met zelfde id/naam/datum", async () => {
    const id = await runCount(10, 3);
    const before = (await repository.getFinalizedSessionResult(id))!;
    const sessionBefore = (await repository.getSession(id))!;

    const outcome = await service.correct(id, [{ articleId: "office-1:M1", newTotalCount: 12 }], "typfout");
    expect(outcome.records).toHaveLength(1);

    const after = (await repository.getFinalizedSessionResult(id))!;
    const row = after.snapshot.articles.find((a) => a.articleId === "office-1:M1")!;
    expect(row.totalCount).toBe(12);
    expect(row.differenceQuantity).toBe(7);
    expect(row.amount).toBe(24);
    expect(row.differenceAmount).toBe(14);
    expect(row.costPrice).toBe(2);
    expect(row.note).toContain("Gecorrigeerd van 10 naar 12");
    expect(after.snapshot.articles.find((a) => a.articleId === "office-1:M2")!.totalCount).toBe(3);
    expect(after.snapshot.sessionName).toBe(before.snapshot.sessionName);
    expect(after.snapshot.snapshotDate).toBe(before.snapshot.snapshotDate);
    expect(after.review.results.find((r) => r.articleId === "office-1:M1")!.newTotalCount).toBe(12);
    expect(after.corrections).toHaveLength(1);

    const sessionAfter = (await repository.getSession(id))!;
    expect(sessionAfter).toEqual(sessionBefore);
    expect(await repository.getSessionsForOffice("office-1")).toHaveLength(1);
  });

  it("werkt de HISTORIE-regels van die sessie bij", async () => {
    const id = await runCount(10, 3);
    await service.correct(id, [{ articleId: "office-1:M1", newTotalCount: 12 }], null);
    const name = (await repository.getFinalizedSessionResult(id))!.snapshot.sessionName;
    const history = await repository.getStockHistoryEntries("office-1");
    const m1 = history.find((h) => h.sessionName === name && h.articleId === "office-1:M1")!;
    expect(m1.totalCount).toBe(12);
    expect(m1.differenceQuantity).toBe(7);
    expect(history.find((h) => h.sessionName === name && h.articleId === "office-1:M2")!.totalCount).toBe(3);
  });

  it("zet previousCount enkel bij als dit de laatste afgeronde telling is", async () => {
    const first = await runCount(10, 3);
    const second = await runCount(20, 4);

    const older = await service.correct(first, [{ articleId: "office-1:M1", newTotalCount: 11 }], null);
    expect(older.previousCountUpdated).toBe(false);
    expect((await repository.getArticles("office-1")).find((a) => a.articleNumber === "M1")!.previousCount).toBe(20);

    const latest = await service.correct(second, [{ articleId: "office-1:M1", newTotalCount: 22 }], null);
    expect(latest.previousCountUpdated).toBe(true);
    expect((await repository.getArticles("office-1")).find((a) => a.articleNumber === "M1")!.previousCount).toBe(22);
    expect((await repository.getArticles("office-1")).find((a) => a.articleNumber === "M2")!.previousCount).toBe(4);
  });

  it("verwijdert de in cache bewaarde Excelsheet van de sessie zodat export opnieuw opbouwt", async () => {
    const id = await runCount(10, 3);
    const name = (await repository.getFinalizedSessionResult(id))!.snapshot.sessionName;
    await repository.saveHistoricalSheetSnapshot({
      officeId: "office-1",
      sheetName: name,
      rows: [["x"]],
      sessionId: id,
    });
    expect(await repository.getHistoricalSheetSnapshots("office-1")).toHaveLength(1);
    await service.correct(id, [{ articleId: "office-1:M1", newTotalCount: 12 }], null);
    expect(await repository.getHistoricalSheetSnapshots("office-1")).toHaveLength(0);
  });

  it("een correctie naar hetzelfde aantal is een no-op", async () => {
    const id = await runCount(10, 3);
    const outcome = await service.correct(id, [{ articleId: "office-1:M1", newTotalCount: 10 }], null);
    expect(outcome.records).toHaveLength(0);
    expect((await repository.getFinalizedSessionResult(id))!.corrections).toBeUndefined();
  });

  it("weigert negatieve aantallen, onbekende artikelen en niet-afgeronde sessies", async () => {
    const id = await runCount(10, 3);
    await expect(service.correct(id, [{ articleId: "office-1:M1", newTotalCount: -1 }], null)).rejects.toThrow(
      SessionCorrectionError,
    );
    await expect(service.correct(id, [{ articleId: "office-1:ZZ", newTotalCount: 1 }], null)).rejects.toThrow(
      SessionCorrectionError,
    );
    const active = await sessions.startSession("office-1", "MONTHLY");
    await expect(service.correct(active.id, [], null)).rejects.toThrow(SessionNotCorrectableError);
  });

  it("exporteert de correcties (laatste per artikel, origineel blijft het eerste oude aantal)", async () => {
    const id = await runCount(10, 3);
    await expect(service.exportCorrections(id)).rejects.toThrow(SessionNotCorrectableError);
    await service.correct(id, [{ articleId: "office-1:M1", newTotalCount: 12 }], "a", "2026-10-10T10:00:00.000Z");
    await service.correct(id, [{ articleId: "office-1:M1", newTotalCount: 13 }], "b", "2026-10-10T11:00:00.000Z");
    const file = await service.exportCorrections(id, "2026-10-11T00:00:00.000Z");
    expect(file.content.kind).toBe("argona-session-corrections");
    expect(file.content.corrections).toHaveLength(1);
    expect(file.content.corrections[0]).toMatchObject({ articleNumber: "M1", oldTotalCount: 10, newTotalCount: 13 });
    expect(file.fileName).toMatch(/^correcties-office-1-.*\.json$/);
  });
});
