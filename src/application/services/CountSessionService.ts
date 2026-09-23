import { selectArticlesForSessionType } from "../../domain/frequency";
import { activeLocationsInOrder } from "../../domain/locations";
import {
  buildNextPreviousCounts,
  computeSessionReview,
  isSessionReadyToComplete,
} from "../../domain/review";
import type { SessionReviewSummary } from "../../domain/review";
import {
  buildHistoryEntriesFromSnapshot,
  buildSessionSnapshot,
  mergeHistoryEntries,
} from "../../domain/stockSnapshot";
import type { Article, CountEntry, CountSession, CountSessionType } from "../../domain/types";
import { generateSessionId } from "../../shared/ids";
import type { CountingRepository } from "../ports/CountingRepository";

export interface SessionScopePreview {
  sessionType: CountSessionType;
  articleCount: number;
}

/**
 * Bouwt de gebruikersgerichte foutmelding voor `SessionIncompleteError`
 * (spec v0.2.1 §6). Beide blokkerende voorwaarden krijgen een eigen,
 * duidelijke zin — locaties eerst, dan artikelen — zodat de gebruiker meteen
 * weet wat er nog moet gebeuren, bv.:
 *   "De telling kan nog niet worden afgerond. 2 locaties zijn nog niet
 *   afgerond: Rek 2, 2e magazijn."
 */
function buildSessionIncompleteMessage(
  notCountedArticles: number,
  incompleteLocationNames: string[],
): string {
  const parts: string[] = [];
  if (incompleteLocationNames.length > 0) {
    const n = incompleteLocationNames.length;
    parts.push(
      `${n} locatie${n === 1 ? "" : "s"} ${n === 1 ? "is" : "zijn"} nog niet afgerond: ${incompleteLocationNames.join(", ")}.`,
    );
  }
  if (notCountedArticles > 0) {
    parts.push(`${notCountedArticles} artikel(en) in scope zijn nog niet (volledig) geteld.`);
  }
  return `De telling kan nog niet worden afgerond. ${parts.join(" ")}`;
}

/**
 * Gegooid door `completeSession` wanneer nog niet aan beide afrondvoorwaarden
 * voldaan is (spec v0.2.1 §6): (1) alle actieve locaties expliciet afgerond,
 * en (2) alle artikelen in scope opgelost (volledig geteld of expliciet
 * bevestigd afwezig). De UI vangt dit op en toont de waarschuwing — er is
 * bewust geen "force"-optie: geen enkele aanroeper mag een sessie stilletjes
 * met open locaties of ontbrekende tellingen afronden.
 */
export class SessionIncompleteError extends Error {
  readonly notCountedArticles: number;
  /** Namen van de actieve locaties die nog niet afgerond zijn (kan leeg zijn). */
  readonly incompleteLocationNames: string[];

  constructor(notCountedArticles: number, incompleteLocationNames: string[] = []) {
    super(buildSessionIncompleteMessage(notCountedArticles, incompleteLocationNames));
    this.name = "SessionIncompleteError";
    this.notCountedArticles = notCountedArticles;
    this.incompleteLocationNames = incompleteLocationNames;
  }
}

/**
 * Gegooid door `startSession` wanneer er al een ACTIEVE sessie bestaat voor
 * dit kantoor (sessielogica-fix: "per kantoor mag maximaal één ACTIVE
 * CountSession bestaan"). Vervangt het oude, stilzwijgende gedrag waarbij
 * `startSession` gewoon de bestaande actieve sessie teruggaf — dat liet
 * "Nieuwe telling" een andere sessie hervatten zonder dat de gebruiker dat
 * doorhad, zeker wanneer het gekozen type niet overeenkwam met het actieve
 * type. De UI (HomePage) vangt dit op en toont een duidelijke keuzedialoog
 * i.p.v. stilletjes te hervatten of te crashen.
 */
export class ActiveSessionExistsError extends Error {
  readonly officeId: string;
  readonly activeSessionId: string;
  readonly activeSessionType: CountSessionType;
  readonly startedAt: string;

  constructor(activeSession: CountSession) {
    super(
      `Er loopt al een actieve telling (${activeSession.type}) voor kantoor ${activeSession.officeId}, ` +
        `gestart op ${activeSession.startedAt}. Rond of annuleer die eerst.`,
    );
    this.name = "ActiveSessionExistsError";
    this.officeId = activeSession.officeId;
    this.activeSessionId = activeSession.id;
    this.activeSessionType = activeSession.type;
    this.startedAt = activeSession.startedAt;
  }
}

/**
 * Gegooid door `completeSession`/`cancelSession` wanneer de sessie niet (meer)
 * ACTIVE is — een reeds afgeronde of geannuleerde sessie is definitief en mag
 * nooit alsnog afgerond/geannuleerd worden (dat zou het rollend archief of de
 * "één actieve sessie per kantoor"-regel kunnen ondermijnen).
 */
export class SessionNotActiveError extends Error {
  readonly sessionId: string;
  readonly actualStatus: string;

  constructor(sessionId: string, actualStatus: string) {
    super(`Sessie ${sessionId} heeft status ${actualStatus}, niet ACTIVE — deze actie is niet toegestaan.`);
    this.name = "SessionNotActiveError";
    this.sessionId = sessionId;
    this.actualStatus = actualStatus;
  }
}

/**
 * Bepaalt en start telsessies, en berekent/valideert de resultatenreview
 * die aan het afronden voorafgaat (spec v0.2 §1-4).
 */
export class CountSessionService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  /** Voor het "Nieuwe stocktelling"-scherm: toon meteen hoeveel artikelen elk type zou bevatten. */
  async previewScopes(officeId: string): Promise<SessionScopePreview[]> {
    const articles = await this.repository.getArticles(officeId);
    const types: CountSessionType[] = ["MONTHLY", "QUARTERLY", "YEARLY", "FULL"];
    return types.map((sessionType) => ({
      sessionType,
      articleCount: selectArticlesForSessionType(articles, sessionType).length,
    }));
  }

  async getActiveSession(officeId: string): Promise<CountSession | undefined> {
    return this.repository.getActiveSession(officeId);
  }

  /**
   * Start een nieuwe telling. Businessregel (sessielogica-fix): per kantoor
   * mag maximaal één ACTIVE sessie bestaan. Als er al één actief is, wordt er
   * NOOIT stilzwijgend een (andere) sessie teruggegeven — dat gooide voorheen
   * verwarrend een sessie van een ander type terug bij "Nieuwe telling". De
   * aanroeper (UI) moet expliciet eerst laten hervatten of annuleren.
   */
  async startSession(officeId: string, sessionType: CountSessionType): Promise<CountSession> {
    const existingActive = await this.repository.getActiveSession(officeId);
    if (existingActive) {
      throw new ActiveSessionExistsError(existingActive);
    }

    const articles = await this.repository.getArticles(officeId);
    const scopeArticles = selectArticlesForSessionType(articles, sessionType);
    const importMeta = await this.repository.getImportMeta(officeId);
    const office = await this.repository.getOffice(officeId);

    // Data-integriteit-sprint §5: bevries, net als `articleIds`, ook de op
    // dit moment actieve fysieke locaties van dit kantoor. Vanaf nu bepaalt
    // DEZE set (niet de later mogelijk gewijzigde `office.locations`) welke
    // locaties voor DEZE sessie afgerond moeten worden — zie
    // `domain/locations.ts#sessionLocations` / `domain/review.ts`.
    const locationIds = office ? activeLocationsInOrder(office).map((location) => location.id) : [];

    const session: CountSession = {
      id: generateSessionId(),
      officeId,
      type: sessionType,
      status: "ACTIVE",
      startedAt: new Date().toISOString(),
      completedAt: null,
      sourceFileName: importMeta?.sourceFileName ?? "",
      sourceBaseDate: office?.baseDate ?? null,
      articleIds: scopeArticles.map((article) => article.id),
      locationIds,
    };

    await this.repository.createSession(session);
    await this.repository.saveCountEntries(
      await this.buildInitialEntries(session.id, officeId, scopeArticles),
    );

    return session;
  }

  /**
   * Berekent de volledige resultatenreview van een sessie (spec v0.2 §1-2):
   * totalen, per-artikel resultaten (incl. handmatige buiten-scope-
   * toevoegingen), filters. Puur een berekening op reeds bewaarde data —
   * schrijft niets.
   */
  async getReview(sessionId: string): Promise<SessionReviewSummary> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    const [articles, entries, office, locationStatuses] = await Promise.all([
      this.repository.getArticles(session.officeId),
      this.repository.getCountEntries(sessionId),
      this.repository.getOffice(session.officeId),
      this.repository.getLocationSessionStatuses(sessionId),
    ]);
    if (!office) {
      throw new Error(`Kantoor ${session.officeId} niet gevonden.`);
    }
    return computeSessionReview(session, articles, office.locations, entries, locationStatuses);
  }

  /**
   * Rondt een sessie af. Standaard enkel toegestaan wanneer BEIDE
   * afrondvoorwaarden vervuld zijn (spec v0.2.1 §6): alle actieve locaties
   * zijn expliciet afgerond, én alle scope-artikelen zijn opgelost (volledig
   * geteld of expliciet bevestigd afwezig) — anders `SessionIncompleteError`.
   * Er is bewust geen "force"-parameter: als dat ooit nodig is, is dat een
   * nieuwe, expliciete beslissing voor een latere sprint.
   */
  async completeSession(sessionId: string): Promise<void> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    // Sessielogica-fix: een reeds geannuleerde (of eerder al afgeronde)
    // sessie mag nooit alsnog "afgerond" worden — dat zou een CANCELLED
    // sessie via een achterpoortje toch nog een officiële telling maken
    // (nieuw tabblad/HISTORIE/previousCount), precies wat punt 7 verbiedt.
    if (session.status !== "ACTIVE") {
      throw new SessionNotActiveError(sessionId, session.status);
    }
    const review = await this.getReview(sessionId);
    if (!isSessionReadyToComplete(review)) {
      throw new SessionIncompleteError(
        review.notCountedArticles,
        review.incompleteActiveLocations.map((l) => l.name),
      );
    }
    await this.finalize(session);
  }

  /**
   * Aanvulling: "Afronden met openstaande artikels" — de uitzonderingsflow
   * naast de standaard, strikte `completeSession`. In tegenstelling tot die
   * laatste wordt hier NOOIT `isSessionReadyToComplete` gecontroleerd: noch
   * openstaande locaties, noch niet (volledig) getelde artikelen blokkeren
   * dit — de gebruiker heeft dat al expliciet bevestigd in de UI ("Afronden
   * en vorige voorraad overnemen"). De sessie wordt hierdoor een volwaardige
   * `COMPLETED` sessie (benoemd tellingtabblad, HISTORIE-regels,
   * `completedAt`) — er wordt hier bewust GEEN CountEntry, locatie of
   * ArticleLocationAssignment aangemaakt: dit roept enkel dezelfde gedeelde
   * `finalize` aan als de strikte `completeSession` hieronder, niets anders.
   * Het is aan `domain/stockSnapshot.ts#buildArticleSnapshot`
   * om, puur op basis van het reeds bestaande (mogelijk onvolledige)
   * reviewresultaat, elk niet-opgelost scope-artikel correct te markeren als
   * `"OVERGENOMEN - NIET GETELD"` i.p.v. (foutief) `GETELD` — die logica kent
   * geen enkel verschil tussen een strikte en een uitzonderlijke afronding,
   * ze leest gewoon af of er een reviewresultaat bestaat en of dat volledig
   * geteld is.
   */
  async completeSessionWithOutstandingArticles(sessionId: string): Promise<void> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    if (session.status !== "ACTIVE") {
      throw new SessionNotActiveError(sessionId, session.status);
    }
    await this.finalize(session);
  }

  /**
   * Data-integriteit-sprint §3 (belangrijkste architecturale wijziging): DE
   * ENE, consistente finalisatie-operatie achter "Telling afronden" — of dat
   * nu via de strikte `completeSession` of via de uitzondering
   * `completeSessionWithOutstandingArticles` gebeurt, ze komen hier allebei
   * samen. Vroeger gebeurde dit (definitieve resultaten berekenen, de
   * volledige StockSnapshot bouwen, HISTORIE definitief wegschrijven,
   * `Article.previousCount` bijwerken) pas bij Excel-EXPORT
   * (`ExportService`) — met als gevolg dat een sessie die nooit
   * geëxporteerd werd, ook nooit haar `previousCount`/HISTORIE bijdroeg aan
   * een volgende sessie. Nu gebeurt dit ÉÉN keer, hier, meteen bij het
   * afronden zelf:
   *   1. de nog-ACTUELE (dus nog niet bijgewerkte) artikelstam/entries/
   *      locatiestatussen ophalen;
   *   2. de definitieve review + volledige StockSnapshot berekenen (puur,
   *      via domain/review.ts en domain/stockSnapshot.ts — exact dezelfde
   *      functies die ExportService voorheen zelf aanriep);
   *   3. de HISTORIE-regels van deze sessie afleiden en samenvoegen met de
   *      reeds bestaande HISTORIE-log;
   *   4. `Article.previousCount` bijwerken (enkel voor artikelen die deze
   *      sessie effectief volledig geteld/bevestigd werden —
   *      `buildNextPreviousCounts` liet OVERGENOMEN(-NIET-GETELD)-artikelen
   *      altijd al terecht ongemoeid);
   *   5. dit alles + de sessie zelf (status COMPLETED, `completedAt` nu) in
   *      ÉÉN Dexie-transactie wegschrijven (`repository.finalizeSession`) —
   *      faalt er iets, dan blijft de sessie gewoon ACTIVE, nooit een half
   *      bijgewerkte staat.
   *
   * Na deze aanroep is de sessie COMPLETED = onveranderlijk, en is
   * `ExportService` nog enkel een PURE serialisatie van het hier bevroren
   * resultaat (zie `repository.getFinalizedSessionResult`) — export mag
   * vanaf nu geen businessstatus meer wijzigen.
   */
  private async finalize(session: CountSession): Promise<void> {
    const [articles, entries, office, locationStatuses, existingHistory] = await Promise.all([
      this.repository.getArticles(session.officeId),
      this.repository.getCountEntries(session.id),
      this.repository.getOffice(session.officeId),
      this.repository.getLocationSessionStatuses(session.id),
      this.repository.getStockHistoryEntries(session.officeId),
    ]);
    if (!office) {
      throw new Error(`Kantoor ${session.officeId} niet gevonden.`);
    }

    const completedSession: CountSession = {
      ...session,
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
    };

    const review = computeSessionReview(completedSession, articles, office.locations, entries, locationStatuses);
    const snapshot = buildSessionSnapshot(completedSession, articles, review);
    const newHistoryEntries = buildHistoryEntriesFromSnapshot(snapshot, office.locations);
    const mergedHistoryEntries = mergeHistoryEntries(existingHistory, newHistoryEntries);

    const nextPreviousCounts = buildNextPreviousCounts(articles, review.results);
    const updatedArticles = articles.map((article) => ({
      ...article,
      previousCount: nextPreviousCounts.get(article.id) ?? article.previousCount,
    }));

    await this.repository.finalizeSession({
      session: completedSession,
      updatedArticles,
      historyEntries: mergedHistoryEntries,
      review,
      snapshot,
    });
  }

  /**
   * Annuleert een lopende (ACTIVE) sessie — een bewuste, expliciete actie
   * (spec: "Telling annuleren?" bevestigingsdialoog gebeurt in de UI, niet
   * hier). Enkel een ACTIVE sessie mag geannuleerd worden: eenmaal
   * COMPLETED/CANCELLED is definitief. Reeds ingevoerde CountEntries blijven
   * gewoon bestaan (intern/audit — spec), maar de sessie zelf telt vanaf nu
   * nergens meer mee als officiële telling (zie articleHistory.ts,
   * ExportService.ts: die filteren expliciet op status === "COMPLETED").
   */
  async cancelSession(sessionId: string, reason?: string | null): Promise<void> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    if (session.status !== "ACTIVE") {
      throw new SessionNotActiveError(sessionId, session.status);
    }
    await this.repository.cancelSession(sessionId, reason ?? null);
  }

  /** Alle sessies van een kantoor, nieuwste eerst — voor het raadplegen van afgeronde tellingen. */
  async getSessionsForOffice(officeId: string): Promise<CountSession[]> {
    return this.repository.getSessionsForOffice(officeId);
  }

  /**
   * Genereert stub-tellingen (nog niet geteld) voor elk artikel op elke
   * locatie waar het al eerder geleerd is (ArticleLocationAssignment).
   * Artikelen zonder gekende locatie krijgen nog geen entry: die ontstaat
   * pas zodra iemand ze effectief op een locatie telt (zie CountingService).
   */
  private async buildInitialEntries(
    sessionId: string,
    officeId: string,
    scopeArticles: Article[],
  ): Promise<CountEntry[]> {
    const [assignments, office] = await Promise.all([
      this.repository.getArticleLocationAssignments(officeId),
      this.repository.getOffice(officeId),
    ]);
    const activeLocationIds = new Set(
      (office?.locations ?? []).filter((l) => l.active).map((l) => l.id),
    );
    const activeAssignmentsByArticle = new Map<string, string[]>();
    for (const assignment of assignments) {
      // Enkel actieve koppelingen naar nog actieve locaties: een intussen
      // inactief gemaakte locatie krijgt geen nieuwe stub-tellingen meer.
      if (!assignment.active || !activeLocationIds.has(assignment.locationId)) continue;
      const list = activeAssignmentsByArticle.get(assignment.articleId);
      if (list) {
        list.push(assignment.locationId);
      } else {
        activeAssignmentsByArticle.set(assignment.articleId, [assignment.locationId]);
      }
    }

    const entries: CountEntry[] = [];
    for (const article of scopeArticles) {
      const locationIds = activeAssignmentsByArticle.get(article.id) ?? [];
      for (const locationId of locationIds) {
        entries.push({
          id: `${sessionId}:${article.id}:${locationId}`,
          sessionId,
          articleId: article.id,
          locationId,
          quantity: null,
          counted: false,
          countedAt: null,
          note: null,
          resolution: "COUNTED",
        });
      }
    }
    return entries;
  }
}
