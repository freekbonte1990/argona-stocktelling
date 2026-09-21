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
    number: n,
    name: `Locatie ${n}`,
    active: true,
  })),
};

describe("CountSessionService", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;

  /**
   * Afrondvoorwaarde 1 (spec v0.2.1 §6): alle actieve locaties moeten
   * expliciet afgerond zijn. De fixture-office hierboven heeft 5 actieve
   * locaties — deze helper rondt ze allemaal af zodat tests die enkel het
   * artikel-aspect willen testen niet ook nog op de locatievoorwaarde
   * struikelen.
   */
  async function completeAllLocations(sessionId: string): Promise<void> {
    for (const location of office.locations) {
      await countingService.completeLocation(sessionId, location.id);
    }
  }

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

  it("eerste telling (geen enkele ArticleLocationAssignment bestaat) genereert nul initiële entries — pure 'locaties leren'-staat (spec v0.2.1 §2)", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    const entries = await repository.getCountEntries(session.id);
    expect(entries).toHaveLength(0);
    // De sessie zelf bevat wel gewoon de volledige scope — het is enkel de
    // per-locatie stub-generatie die nog niets weet (nog geen enkel artikel
    // ooit ergens geteld voor dit kantoor).
    expect(session.articleIds.sort()).toEqual(["office-1:M1", "office-1:M2"].sort());
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
    await completeAllLocations(first.id);
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
    await completeAllLocations(first.id);
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

  it("weigert af te ronden zolang niet alle scope-artikelen (volledig) geteld zijn, ook als alle locaties al afgerond zijn", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    // M2 blijft ongeteld.
    await completeAllLocations(session.id);
    await expect(sessionService.completeSession(session.id)).rejects.toThrow(
      SessionIncompleteError,
    );

    const stillActive = await repository.getSession(session.id);
    expect(stillActive?.status).toBe("ACTIVE");
    expect(stillActive?.completedAt).toBeNull();
  });

  it("weigert af te ronden zolang niet alle actieve locaties afgerond zijn, ook als alle artikelen al (volledig) geteld zijn", async () => {
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
    // Geen enkele locatie is expliciet afgerond.
    await expect(sessionService.completeSession(session.id)).rejects.toThrow(
      SessionIncompleteError,
    );

    const stillActive = await repository.getSession(session.id);
    expect(stillActive?.status).toBe("ACTIVE");
    expect(stillActive?.completedAt).toBeNull();
  });

  it("de foutmelding noemt de namen van de nog niet afgeronde locaties", async () => {
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
    // Rond alle locaties af behalve twee, zodat we de exacte melding kunnen controleren.
    for (const location of office.locations) {
      if (location.name === "Locatie 2" || location.name === "Locatie 4") continue;
      await countingService.completeLocation(session.id, location.id);
    }

    await expect(sessionService.completeSession(session.id)).rejects.toThrow(
      "De telling kan nog niet worden afgerond. 2 locaties zijn nog niet afgerond: Locatie 2, Locatie 4.",
    );
  });

  it("zet status op COMPLETED en vult completedAt zodra alles geteld en alle locaties afgerond zijn", async () => {
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
    await completeAllLocations(session.id);

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
    await completeAllLocations(session.id);
    await sessionService.completeSession(session.id);

    const sessions = await sessionService.getSessionsForOffice("office-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("COMPLETED");
  });

  it("een expliciete voorraad-0-bevestiging (CONFIRMED_ABSENT) telt als opgelost artikel voor afronding", async () => {
    // "Zonder locatie" is geen fysieke Location en heeft dus geen eigen
    // afrondstatus nodig — een artikel dat enkel via een expliciete
    // "niet aanwezig"-bevestiging opgelost is (geen CountEntry op een
    // fysieke locatie) mag de sessie nooit blokkeren zolang alle échte
    // locaties zelf afgerond zijn (spec v0.2.1 §6, voorwaarde 2).
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.confirmAbsent(session, "office-1:M2");
    await completeAllLocations(session.id);

    await expect(sessionService.completeSession(session.id)).resolves.not.toThrow();
    const completed = await repository.getSession(session.id);
    expect(completed?.status).toBe("COMPLETED");
  });

  it("een locatie die eerst afgerond en daarna opnieuw geopend wordt, maakt de sessie opnieuw niet afrondbaar", async () => {
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
    await completeAllLocations(session.id);

    // Op dit punt is de sessie afrondbaar.
    const readyReview = await sessionService.getReview(session.id);
    expect(readyReview.allLocationsCompleted).toBe(true);

    // Locatie 1 wordt heropend (bv. om toch nog iets te corrigeren).
    await countingService.reopenLocation(session.id, office.locations[0].id);

    await expect(sessionService.completeSession(session.id)).rejects.toThrow(
      SessionIncompleteError,
    );
    const stillActive = await repository.getSession(session.id);
    expect(stillActive?.status).toBe("ACTIVE");

    // En rondt weer normaal af zodra die locatie opnieuw afgerond wordt.
    await countingService.completeLocation(session.id, office.locations[0].id);
    await expect(sessionService.completeSession(session.id)).resolves.not.toThrow();
  });

  it("getReview toont allLocationsCompleted correct op basis van locatiestatus", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    let review = await sessionService.getReview(session.id);
    expect(review.allLocationsCompleted).toBe(false);

    for (const location of office.locations) {
      await countingService.completeLocation(session.id, location.id);
    }
    review = await sessionService.getReview(session.id);
    expect(review.allLocationsCompleted).toBe(true);
  });

  it("een volgende sessie genereert geen stub-entries meer voor een intussen inactief gemaakte locatie", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M2",
      locationId: office.locations[0].id,
      quantity: 1,
    });
    await completeAllLocations(first.id);
    await sessionService.completeSession(first.id);

    // Locatie 1 wordt daarna inactief gemaakt (bv. via Instellingen).
    const officeNow = await repository.getOffice("office-1");
    if (!officeNow) throw new Error("kantoor niet gevonden");
    officeNow.locations[0] = { ...officeNow.locations[0], active: false };
    await repository.saveOffice(officeNow);

    const second = await sessionService.startSession("office-1", "MONTHLY");
    const entries = await repository.getCountEntries(second.id);
    const entryForM1 = entries.find((e) => e.articleId === "office-1:M1");
    expect(entryForM1).toBeUndefined();
  });
});
