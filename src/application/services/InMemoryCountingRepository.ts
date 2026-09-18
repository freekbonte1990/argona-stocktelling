import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  Office,
} from "../../domain/types";
import type { CountingRepository, ImportMeta } from "../ports/CountingRepository";

/**
 * In-memory testdouble voor CountingRepository. Gebruikt in unit tests voor
 * de application-services, zodat die tests niet van een echte IndexedDB
 * (Dexie) afhangen. Wordt niet door de app zelf gebruikt.
 */
export class InMemoryCountingRepository implements CountingRepository {
  private offices = new Map<string, Office>();
  private importMeta = new Map<string, ImportMeta>();
  private articles = new Map<string, Article>();
  private sessions = new Map<string, CountSession>();
  private entries = new Map<string, CountEntry>();
  private assignments = new Map<string, ArticleLocationAssignment>();

  async saveOffice(office: Office): Promise<void> {
    this.offices.set(office.id, office);
  }
  async getOffice(officeId: string): Promise<Office | undefined> {
    return this.offices.get(officeId);
  }
  async getAllOffices(): Promise<Office[]> {
    return Array.from(this.offices.values());
  }

  async saveImportMeta(meta: ImportMeta): Promise<void> {
    this.importMeta.set(meta.officeId, meta);
  }
  async getImportMeta(officeId: string): Promise<ImportMeta | undefined> {
    return this.importMeta.get(officeId);
  }

  async saveArticles(articles: Article[]): Promise<void> {
    for (const article of articles) this.articles.set(article.id, article);
  }
  async getArticles(officeId: string): Promise<Article[]> {
    return Array.from(this.articles.values()).filter((a) => a.officeId === officeId);
  }

  async createSession(session: CountSession): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async getSession(sessionId: string): Promise<CountSession | undefined> {
    return this.sessions.get(sessionId);
  }
  async getActiveSession(officeId: string): Promise<CountSession | undefined> {
    return Array.from(this.sessions.values()).find(
      (s) => s.officeId === officeId && s.status === "ACTIVE",
    );
  }
  async getSessionsForOffice(officeId: string): Promise<CountSession[]> {
    return Array.from(this.sessions.values())
      .filter((s) => s.officeId === officeId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async completeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "COMPLETED";
      session.completedAt = new Date().toISOString();
    }
  }

  async saveCountEntry(entry: CountEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }
  async saveCountEntries(entries: CountEntry[]): Promise<void> {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }
  async getCountEntries(sessionId: string): Promise<CountEntry[]> {
    return Array.from(this.entries.values()).filter((e) => e.sessionId === sessionId);
  }

  async saveArticleLocationAssignment(assignment: ArticleLocationAssignment): Promise<void> {
    this.assignments.set(assignment.id, assignment);
  }
  async getArticleLocationAssignments(officeId: string): Promise<ArticleLocationAssignment[]> {
    return Array.from(this.assignments.values()).filter((a) => a.officeId === officeId);
  }

  private selectedOfficeId: string | undefined;
  async getSelectedOfficeId(): Promise<string | undefined> {
    return this.selectedOfficeId;
  }
  async setSelectedOfficeId(officeId: string): Promise<void> {
    this.selectedOfficeId = officeId;
  }
}
