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
    number: n as 1 | 2 | 3 | 4 | 5,
    name: `Locatie ${n}`,
  })),
};

describe("CountingService", () => {
  let repository: InMemoryCountingRepository;
  let countingService: CountingService;
  let session: CountSession;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    const sessionService = new CountSessionService(repository);
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
});
