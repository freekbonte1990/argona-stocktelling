import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  Office,
} from "../../domain/types";
import type { CountingRepository, ImportMeta } from "../../application/ports/CountingRepository";
import type { AppDatabase } from "./db";
import { db as defaultDb } from "./db";

/**
 * IndexedDB-implementatie van CountingRepository, via Dexie.
 *
 * Dit is de enige plek in de app die effectief met IndexedDB praat. Een
 * toekomstige EBuddyCountingRepository zou dezelfde interface implementeren
 * (bv. bovenop fetch/HTTP) zonder dat services of UI-schermen wijzigen.
 */
export class IndexedDbCountingRepository implements CountingRepository {
  private readonly db: AppDatabase;

  constructor(db: AppDatabase = defaultDb) {
    this.db = db;
  }

  async saveOffice(office: Office): Promise<void> {
    await this.db.offices.put(office);
  }

  async getOffice(officeId: string): Promise<Office | undefined> {
    return this.db.offices.get(officeId);
  }

  async getAllOffices(): Promise<Office[]> {
    return this.db.offices.toArray();
  }

  async saveImportMeta(meta: ImportMeta): Promise<void> {
    await this.db.importMeta.put(meta);
  }

  async getImportMeta(officeId: string): Promise<ImportMeta | undefined> {
    return this.db.importMeta.get(officeId);
  }

  async saveArticles(articles: Article[]): Promise<void> {
    await this.db.articles.bulkPut(articles);
  }

  async getArticles(officeId: string): Promise<Article[]> {
    return this.db.articles.where("officeId").equals(officeId).toArray();
  }

  async createSession(session: CountSession): Promise<void> {
    await this.db.sessions.put(session);
  }

  async getSession(sessionId: string): Promise<CountSession | undefined> {
    return this.db.sessions.get(sessionId);
  }

  async getActiveSession(officeId: string): Promise<CountSession | undefined> {
    return this.db.sessions
      .where("officeId")
      .equals(officeId)
      .and((session) => session.status === "ACTIVE")
      .first();
  }

  async getSessionsForOffice(officeId: string): Promise<CountSession[]> {
    const sessions = await this.db.sessions.where("officeId").equals(officeId).toArray();
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async completeSession(sessionId: string): Promise<void> {
    await this.db.sessions.update(sessionId, {
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
    });
  }

  async saveCountEntry(entry: CountEntry): Promise<void> {
    await this.db.countEntries.put(entry);
  }

  async saveCountEntries(entries: CountEntry[]): Promise<void> {
    await this.db.countEntries.bulkPut(entries);
  }

  async getCountEntries(sessionId: string): Promise<CountEntry[]> {
    return this.db.countEntries.where("sessionId").equals(sessionId).toArray();
  }

  async saveArticleLocationAssignment(assignment: ArticleLocationAssignment): Promise<void> {
    await this.db.assignments.put(assignment);
  }

  async getArticleLocationAssignments(officeId: string): Promise<ArticleLocationAssignment[]> {
    return this.db.assignments.where("officeId").equals(officeId).toArray();
  }

  async getSelectedOfficeId(): Promise<string | undefined> {
    const row = await this.db.appState.get("singleton");
    return row?.selectedOfficeId;
  }

  async setSelectedOfficeId(officeId: string): Promise<void> {
    await this.db.appState.put({ id: "singleton", selectedOfficeId: officeId });
  }
}
