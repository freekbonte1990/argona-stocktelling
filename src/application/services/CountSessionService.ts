import { selectArticlesForSessionType } from "../../domain/frequency";
import type { Article, CountEntry, CountSession, CountSessionType } from "../../domain/types";
import { generateSessionId } from "../../shared/ids";
import type { CountingRepository } from "../ports/CountingRepository";

export interface SessionScopePreview {
  sessionType: CountSessionType;
  articleCount: number;
}

/**
 * Bepaalt en start telsessies.
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

  async completeSession(sessionId: string): Promise<void> {
    await this.repository.completeSession(sessionId);
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
    const assignments = await this.repository.getArticleLocationAssignments(officeId);
    const activeAssignmentsByArticle = new Map<string, string[]>();
    for (const assignment of assignments) {
      if (!assignment.active) continue;
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
        });
      }
    }
    return entries;
  }
}
