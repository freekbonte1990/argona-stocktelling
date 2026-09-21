import { selectArticlesForSessionType } from "../../domain/frequency";
import { computeSessionReview, isSessionReadyToComplete } from "../../domain/review";
import type { SessionReviewSummary } from "../../domain/review";
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

  async startSession(officeId: string, sessionType: CountSessionType): Promise<CountSession> {
    const existingActive = await this.repository.getActiveSession(officeId);
    if (existingActive) {
      return existingActive;
    }

    const articles = await this.repository.getArticles(officeId);
    const scopeArticles = selectArticlesForSessionType(articles, sessionType);
    const importMeta = await this.repository.getImportMeta(officeId);
    const office = await this.repository.getOffice(officeId);

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
    const review = await this.getReview(sessionId);
    if (!isSessionReadyToComplete(review)) {
      throw new SessionIncompleteError(
        review.notCountedArticles,
        review.incompleteActiveLocations.map((l) => l.name),
      );
    }
    await this.repository.completeSession(sessionId);
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
