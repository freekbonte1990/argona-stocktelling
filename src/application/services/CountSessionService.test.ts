import { beforeEach, describe, expect, it } from "vitest";
import {
  ActiveSessionExistsError,
  CountSessionService,
  SessionIncompleteError,
  SessionNotActiveError,
  SessionNotDeletableError,
} from "./CountSessionService";
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

  /**
   * Sessielogica-fix: per kantoor mag maximaal één ACTIVE sessie bestaan.
   * `startSession` mag een bestaande actieve sessie NOOIT meer stilzwijgend
   * teruggeven (het oude gedrag hier) — dat liet "Nieuwe telling" een sessie
   * van een ANDER type hervatten zonder dat de gebruiker dat doorhad.
   */
  it("startSession zonder actieve sessie start gewoon een nieuwe ACTIVE sessie", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    expect(session.status).toBe("ACTIVE");
    expect(session.type).toBe("MONTHLY");
  });

  it("startSession met een reeds actieve sessie gooit ActiveSessionExistsError i.p.v. stilzwijgend te hervatten", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");

    await expect(sessionService.startSession("office-1", "YEARLY")).rejects.toThrow(
      ActiveSessionExistsError,
    );
    try {
      await sessionService.startSession("office-1", "YEARLY");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ActiveSessionExistsError);
      const typed = err as ActiveSessionExistsError;
      expect(typed.officeId).toBe("office-1");
      expect(typed.activeSessionId).toBe(first.id);
      expect(typed.activeSessionType).toBe("MONTHLY");
      expect(typed.startedAt).toBe(first.startedAt);
    }
  });

  it("de actieve sessie blijft volledig ongewijzigd na een mislukte startpoging", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    await expect(sessionService.startSession("office-1", "QUARTERLY")).rejects.toThrow(
      ActiveSessionExistsError,
    );

    const stillActive = await repository.getSession(first.id);
    expect(stillActive).toEqual(first);
    // Er mag ook geen tweede sessie stiekem aangemaakt zijn.
    expect(await sessionService.getSessionsForOffice("office-1")).toHaveLength(1);
  });

  it("cancelSession zet status op CANCELLED en vult cancelledAt", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await sessionService.cancelSession(session.id);

    const cancelled = await repository.getSession(session.id);
    expect(cancelled?.status).toBe("CANCELLED");
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(new Date(cancelled!.cancelledAt as string).toString()).not.toBe("Invalid Date");
  });

  it("een geannuleerde sessie blokkeert geen nieuwe telling meer", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    await sessionService.cancelSession(first.id);

    const second = await sessionService.startSession("office-1", "MONTHLY");
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("ACTIVE");
  });

  it("een nieuwe sessie na annuleren heeft een ander UUID en bevat geen CountEntries van de geannuleerde sessie", async () => {
    const first = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session: first,
      articleId: "office-1:M1",
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await sessionService.cancelSession(first.id);

    const second = await sessionService.startSession("office-1", "MONTHLY");
    expect(second.id).not.toBe(first.id);

    const secondEntries = await repository.getCountEntries(second.id);
    // De sessie start met een lege staat: geen enkele entry van de
    // geannuleerde sessie lekt door (ook niet als "reeds geteld").
    expect(secondEntries.every((e) => e.counted === false)).toBe(true);
    expect(secondEntries.some((e) => e.id.startsWith(first.id))).toBe(false);

    // De CountEntries van de geannuleerde sessie zelf blijven wel gewoon
    // bestaan (audit/debug — spec punt 4), enkel gekoppeld aan hun eigen sessieId.
    const firstEntries = await repository.getCountEntries(first.id);
    expect(firstEntries).toHaveLength(1);
    expect(firstEntries[0].sessionId).toBe(first.id);
  });

  it("cancelSession op een niet-actieve sessie gooit SessionNotActiveError", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await sessionService.cancelSession(session.id);

    await expect(sessionService.cancelSession(session.id)).rejects.toThrow(SessionNotActiveError);
  });

  it("completeSession op een geannuleerde sessie gooit SessionNotActiveError i.p.v. ze te heropenen als officiële telling", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await sessionService.cancelSession(session.id);

    await expect(sessionService.completeSession(session.id)).rejects.toThrow(SessionNotActiveError);
    const stillCancelled = await repository.getSession(session.id);
    expect(stillCancelled?.status).toBe("CANCELLED");
  });

  /**
   * Aanvulling: "Afronden met openstaande artikels" — de uitzonderingsflow.
   */
  describe("completeSessionWithOutstandingArticles (aanvulling)", () => {
    it("strikte completeSession blijft blokkeren bij een onvolledige telling", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: office.locations[0].id,
        quantity: 3,
      });
      // M2 blijft ongeteld, geen enkele locatie afgerond.
      await expect(sessionService.completeSession(session.id)).rejects.toThrow(SessionIncompleteError);
      const stillActive = await repository.getSession(session.id);
      expect(stillActive?.status).toBe("ACTIVE");
    });

    it("werkt na expliciete aanroep, ook met openstaande artikels EN openstaande locaties", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: office.locations[0].id,
        quantity: 3,
      });
      // M2 blijft ongeteld; geen enkele locatie afgerond ("open locatie mag
      // de uitzonderlijke afronding niet blokkeren").
      await sessionService.completeSessionWithOutstandingArticles(session.id);

      const completed = await repository.getSession(session.id);
      expect(completed?.status).toBe("COMPLETED");
      expect(completed?.completedAt).not.toBeNull();
    });

    it("maakt geen fictieve CountEntry of ArticleLocationAssignment voor het niet-getelde artikel", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: office.locations[0].id,
        quantity: 3,
      });
      const entriesBefore = await repository.getCountEntries(session.id);
      const assignmentsBefore = await repository.getArticleLocationAssignments("office-1");

      await sessionService.completeSessionWithOutstandingArticles(session.id);

      const entriesAfter = await repository.getCountEntries(session.id);
      const assignmentsAfter = await repository.getArticleLocationAssignments("office-1");
      // Geen enkele nieuwe entry/koppeling ontstaan voor M2 (het niet-getelde artikel).
      expect(entriesAfter).toEqual(entriesBefore);
      expect(assignmentsAfter).toEqual(assignmentsBefore);
      expect(entriesAfter.some((e) => e.articleId === "office-1:M2")).toBe(false);
    });

    it("wijzigt Article.previousCount niet voor het niet-getelde artikel", async () => {
      const before = (await repository.getArticles("office-1")).find((a) => a.articleNumber === "M2");
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: office.locations[0].id,
        quantity: 3,
      });
      await sessionService.completeSessionWithOutstandingArticles(session.id);

      const after = (await repository.getArticles("office-1")).find((a) => a.articleNumber === "M2");
      expect(after?.previousCount).toBe(before?.previousCount);
    });

    it("completeSessionWithOutstandingArticles vereist een ACTIVE sessie", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await sessionService.cancelSession(session.id);

      await expect(sessionService.completeSessionWithOutstandingArticles(session.id)).rejects.toThrow(
        SessionNotActiveError,
      );
    });
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

  describe("Sprint 3.3 §2: gecentraliseerde count-scope-regel (assortiment + telfrequentie)", () => {
    it("een artikel dat inactief is in het assortiment (historisch-alleen) komt niet meer in scope van een nieuwe telling, ook al past het bij de telfrequentie", async () => {
      await repository.saveArticles([
        makeArticle({ articleNumber: "M1", countPeriod: "MONTHLY", assortmentActive: false }),
      ]);
      const session = await sessionService.startSession("office-1", "MONTHLY");
      expect(session.articleIds).not.toContain("office-1:M1");
      // De andere maandartikelen (nog steeds actief) blijven wél in scope.
      expect(session.articleIds).toContain("office-1:M2");
    });

    it("previewScopes (het 'Nieuwe telling'-scherm) telt een historisch-alleen artikel ook niet mee", async () => {
      await repository.saveArticles([
        makeArticle({ articleNumber: "M1", countPeriod: "MONTHLY", assortmentActive: false }),
      ]);
      const previews = await sessionService.previewScopes("office-1");
      const monthly = previews.find((p) => p.sessionType === "MONTHLY");
      expect(monthly?.articleCount).toBe(1); // enkel M2 nog actief
    });

    it("een inactief-in-assortiment artikel blijft volledig raadpleegbaar: getArticles/geschiedenis blijven werken, het artikel wordt nooit verborgen of verwijderd", async () => {
      await repository.saveArticles([
        makeArticle({ articleNumber: "M1", countPeriod: "MONTHLY", assortmentActive: false, previousCount: 42 }),
      ]);

      // Nieuwe telling sluit het artikel terecht uit...
      const session = await sessionService.startSession("office-1", "MONTHLY");
      expect(session.articleIds).not.toContain("office-1:M1");

      // ...maar het artikel zelf blijft gewoon bestaan/raadpleegbaar (spec:
      // "historical appearances must remain visible even if the article is
      // now inactive").
      const articlesAfter = await repository.getArticles("office-1");
      const historicalArticle = articlesAfter.find((a) => a.id === "office-1:M1");
      expect(historicalArticle).toBeDefined();
      expect(historicalArticle?.previousCount).toBe(42);

      // De rest van de (nog wél actieve) sessiescope moet geteld worden
      // vóór afronden mag — M2 is het enige nog actieve maandartikel.
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 1,
      });

      // Rond de sessie af en bevestig dat het (buiten-scope) artikel als
      // OVERGENOMEN in de HISTORIE-log terechtkomt, exact zoals elk ander
      // buiten-scope artikel (bv. een kwartaalartikel tijdens een
      // maandtelling) — geen enkele regressie t.o.v. de bestaande
      // OVERGENOMEN-logica.
      await completeAllLocations(session.id);
      await sessionService.completeSession(session.id);
      const history = await repository.getStockHistoryEntries("office-1");
      const historyEntry = history.find((h) => h.articleId === "office-1:M1");
      expect(historyEntry).toBeDefined();
      expect(historyEntry?.status).toBe("OVERGENOMEN");
      expect(historyEntry?.totalCount).toBe(42);
    });
  });

  describe("Sprint 3.3 §5: veilig verwijderen van tellingen", () => {
    /** Rondt een volledige MONTHLY-sessie af met de opgegeven tellingen voor M1/M2. */
    async function runMonthlyCount(m1: number, m2: number) {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: office.locations[0].id,
        quantity: m1,
      });
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: m2,
      });
      await completeAllLocations(session.id);
      await sessionService.completeSession(session.id);
      return (await repository.getSession(session.id))!;
    }

    it("weigert een niet-COMPLETED sessie (ACTIVE) te verwijderen", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await expect(sessionService.deleteSession(session.id)).rejects.toThrow(SessionNotDeletableError);
      expect(await repository.getSession(session.id)).toBeDefined();
    });

    it("verwijderen van de MEEST RECENTE telling herstelt previousCount naar de vorige echte fysieke telling", async () => {
      await runMonthlyCount(10, 5);
      const second = await runMonthlyCount(20, 5);

      let articles = await repository.getArticles("office-1");
      expect(articles.find((a) => a.articleNumber === "M1")?.previousCount).toBe(20);

      await sessionService.deleteSession(second.id);

      articles = await repository.getArticles("office-1");
      expect(articles.find((a) => a.articleNumber === "M1")?.previousCount).toBe(10);
      expect(articles.find((a) => a.articleNumber === "M2")?.previousCount).toBe(5);

      // De sessie zelf is weg, maar de artikelen/mastergegevens zelf blijven
      // gewoon bestaan (spec §5: "never delete articles or current master data").
      expect(await repository.getSession(second.id)).toBeUndefined();
      expect(articles).toHaveLength(5);
    });

    it("verwijderen van een MIDDEN-telling wijzigt niets wanneer een latere overblijvende sessie het artikel al herteld heeft", async () => {
      await runMonthlyCount(10, 5);
      const middle = await runMonthlyCount(20, 5);
      await runMonthlyCount(30, 8);

      await sessionService.deleteSession(middle.id);

      const articles = await repository.getArticles("office-1");
      expect(articles.find((a) => a.articleNumber === "M1")?.previousCount).toBe(30);
      expect(articles.find((a) => a.articleNumber === "M2")?.previousCount).toBe(8);
    });

    it("de overblijvende HISTORIE/comparison-data blijft na verwijdering gewoon leesbaar, enkel de verwijderde sessie's eigen regels verdwijnen", async () => {
      // Bewust twee VERSCHILLENDE sessietypes (MONTHLY/QUARTERLY), zodat hun
      // bevroren snapshotnamen (spec: "2026-09 Maand" vs. "2026-Q3 Kwartaal")
      // gegarandeerd verschillen, ook al worden beide "vandaag" afgerond —
      // twee MONTHLY-sessies in dezelfde kalendermaand zouden anders dezelfde
      // HISTORIE-sleutel delen (bestaande, losstaande naamgevingsbeperking).
      const monthly = await runMonthlyCount(10, 5);

      const quarterlySession = await sessionService.startSession("office-1", "QUARTERLY");
      // QUARTERLY-scope omvat ook de MONTHLY-artikelen (spec: cumulatief) —
      // die moeten dus ook opgelost worden vóór deze sessie afgerond kan worden.
      for (const articleId of ["office-1:M1", "office-1:M2"]) {
        await countingService.recordCount({
          session: quarterlySession,
          articleId,
          locationId: office.locations[0].id,
          quantity: 1,
        });
      }
      await countingService.recordCount({
        session: quarterlySession,
        articleId: "office-1:Q1",
        locationId: office.locations[0].id,
        quantity: 7,
      });
      await completeAllLocations(quarterlySession.id);
      await sessionService.completeSession(quarterlySession.id);
      const quarterly = (await repository.getSession(quarterlySession.id))!;
      const quarterlySessionName = (await repository.getFinalizedSessionResult(quarterly.id))!.snapshot
        .sessionName;

      await sessionService.deleteSession(quarterly.id);

      const history = await repository.getStockHistoryEntries("office-1");
      // De HISTORIE-regels van de overblijvende MONTHLY-sessie staan er nog...
      expect(history.some((h) => h.articleId === "office-1:M1" && h.totalCount === 10)).toBe(true);
      // ...maar GEEN ENKELE regel van de verwijderde QUARTERLY-sessie zelf meer
      // (elke HISTORIE-rij wordt uniek gesleuteld op (sessionName, articleId) —
      // Q1 kan wél nog een aparte, eigen OVERGENOMEN-rij hebben onder de
      // MONTHLY-sessienaam, want een snapshot bevat ALTIJD alle artikelen van
      // het kantoor, ook buiten-scope; dat is een APARTE, correcte rij).
      expect(history.some((h) => h.sessionName === quarterlySessionName)).toBe(false);

      const remainingSessions = await sessionService.getSessionsForOffice("office-1");
      expect(remainingSessions.map((s) => s.id)).toEqual([monthly.id]);
      // De MONTHLY-sessie blijft volledig raadpleegbaar (Comparison/Analysis).
      expect(await repository.getFinalizedSessionResult(monthly.id)).toBeDefined();
    });

    it("een legacy-sessie zonder bevroren FinalizedSessionResult wordt gewoon verwijderd, zonder recompute-crash", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: office.locations[0].id,
        quantity: 1,
      });
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: office.locations[0].id,
        quantity: 1,
      });
      await completeAllLocations(session.id);
      // LEGACY-simulatie: rond af via de oude, niet-finaliserende repository-methode
      // in plaats van sessionService.completeSession (die altijd finalizeSession gebruikt) —
      // zodat er hier bewust GEEN FinalizedSessionResult bestaat.
      await repository.completeSession(session.id);

      await expect(sessionService.deleteSession(session.id)).resolves.not.toThrow();
      expect(await repository.getSession(session.id)).toBeUndefined();
    });
  });
});
