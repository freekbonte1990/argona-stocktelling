import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { LocationAssignmentService } from "./LocationAssignmentService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * v0.2.1 bulk locatiebeheer §7-10: dit dekt de orchestratielaag
 * (repository lezen/schrijven) rond de pure planning in
 * domain/bulkLocationAssignment.test.ts, en vooral de veiligheidseis van
 * spec §9: bulk locatiebeheer mag NOOIT CountEntry's, afgeronde tellingen
 * of voorraadhoeveelheden wijzigen.
 */

function makeArticle(articleNumber: string): Article {
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
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
  };
}

const office: Office = {
  id: "office-1",
  name: "Antwerpen",
  baseDate: null,
  locations: [1, 2, 3].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n,
    name: `Locatie ${n}`,
    active: true,
  })),
};

describe("LocationAssignmentService", () => {
  let repository: InMemoryCountingRepository;
  let locationAssignmentService: LocationAssignmentService;
  let countingService: CountingService;
  let session: CountSession;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    locationAssignmentService = new LocationAssignmentService(repository);
    countingService = new CountingService(repository);
    const sessionService = new CountSessionService(repository);
    await repository.saveOffice(office);
    await repository.saveArticles([makeArticle("A1"), makeArticle("A2"), makeArticle("A3")]);
    session = await sessionService.startSession("office-1", "MONTHLY");
  });

  it("meerdere artikels selecteren en 'Locatie toevoegen' koppelt de locatie aan elk van hen", async () => {
    await locationAssignmentService.addLocation("office-1", ["office-1:A1", "office-1:A2"], "office-1:loc-1");

    const assignments = await repository.getArticleLocationAssignments("office-1");
    const activeForLoc1 = assignments.filter((a) => a.locationId === "office-1:loc-1" && a.active);
    expect(activeForLoc1.map((a) => a.articleId).sort()).toEqual(["office-1:A1", "office-1:A2"]);
  });

  it("bestaande tweede locatie blijft behouden bij 'Locatie toevoegen'", async () => {
    await locationAssignmentService.addLocation("office-1", ["office-1:A1"], "office-1:loc-1");
    await locationAssignmentService.addLocation("office-1", ["office-1:A1"], "office-1:loc-2");

    const assignments = await repository.getArticleLocationAssignments("office-1");
    const activeForA1 = assignments.filter((a) => a.articleId === "office-1:A1" && a.active);
    expect(activeForA1.map((a) => a.locationId).sort()).toEqual(["office-1:loc-1", "office-1:loc-2"]);
  });

  it("'Locatie verwijderen' verwijdert enkel de gekozen locatie, andere koppelingen van hetzelfde artikel blijven staan", async () => {
    await locationAssignmentService.addLocation("office-1", ["office-1:A1"], "office-1:loc-1");
    await locationAssignmentService.addLocation("office-1", ["office-1:A1"], "office-1:loc-2");

    await locationAssignmentService.removeLocation("office-1", ["office-1:A1"], "office-1:loc-1");

    const assignments = await repository.getArticleLocationAssignments("office-1");
    const forA1 = assignments.filter((a) => a.articleId === "office-1:A1");
    const loc1 = forA1.find((a) => a.locationId === "office-1:loc-1");
    const loc2 = forA1.find((a) => a.locationId === "office-1:loc-2");
    expect(loc1?.active).toBe(false);
    expect(loc2?.active).toBe(true);
  });

  it("'Verplaatsen naar' vervangt de huidige actieve locatie(s) van de geselecteerde artikels", async () => {
    await locationAssignmentService.addLocation("office-1", ["office-1:A1", "office-1:A2"], "office-1:loc-1");

    await locationAssignmentService.moveToLocation("office-1", ["office-1:A1", "office-1:A2"], "office-1:loc-3");

    const assignments = await repository.getArticleLocationAssignments("office-1");
    for (const articleId of ["office-1:A1", "office-1:A2"]) {
      const forArticle = assignments.filter((a) => a.articleId === articleId);
      expect(forArticle.find((a) => a.locationId === "office-1:loc-1")?.active).toBe(false);
      expect(forArticle.find((a) => a.locationId === "office-1:loc-3")?.active).toBe(true);
    }
  });

  it("bulk locatiebeheer (toevoegen/verwijderen/verplaatsen) wijzigt nooit bestaande CountEntry's (spec §9)", async () => {
    const entry = await countingService.recordCount({
      session,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 7,
    });

    await locationAssignmentService.addLocation("office-1", ["office-1:A1"], "office-1:loc-2");
    await locationAssignmentService.moveToLocation("office-1", ["office-1:A1"], "office-1:loc-3");
    await locationAssignmentService.removeLocation("office-1", ["office-1:A1"], "office-1:loc-1");

    const entries = await repository.getCountEntries(session.id);
    const stillThere = entries.find((e) => e.id === entry.id);
    expect(stillThere).toEqual(entry);
    expect(stillThere?.quantity).toBe(7);
    expect(stillThere?.locationId).toBe("office-1:loc-1");
  });

  it("selecteer alle gefilterde artikels (select all) → 'Locatie toevoegen' past alle drie tegelijk aan", async () => {
    const allArticleIds = ["office-1:A1", "office-1:A2", "office-1:A3"];
    await locationAssignmentService.addLocation("office-1", allArticleIds, "office-1:loc-1");

    const assignments = await repository.getArticleLocationAssignments("office-1");
    const active = assignments.filter((a) => a.locationId === "office-1:loc-1" && a.active);
    expect(active.map((a) => a.articleId).sort()).toEqual(allArticleIds.sort());
  });
});
