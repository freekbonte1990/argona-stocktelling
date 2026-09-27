import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  LocationSessionStatus,
  Office,
  ProductCategory,
} from "../../domain/types";
import type {
  CountingRepository,
  DeleteSessionInput,
  FinalizedSessionResult,
  FinalizeSessionInput,
  HistoricalSheetRecord,
  ImportMeta,
} from "../../application/ports/CountingRepository";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";
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

  async getAllArticles(): Promise<Article[]> {
    return this.db.articles.toArray();
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

  /**
   * Data-integriteit-sprint §3: alles in ÉÉN Dexie-transactie — faalt één
   * van de vier schrijfacties (bv. door een IndexedDB-quotafout), dan wordt
   * de volledige transactie teruggedraaid en blijft de sessie gewoon ACTIVE
   * (nooit een half afgeronde sessie).
   */
  async finalizeSession(input: FinalizeSessionInput): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.sessions, this.db.articles, this.db.stockHistoryEntries, this.db.finalizedSessionResults],
      async () => {
        await this.db.sessions.put(input.session);
        await this.db.articles.bulkPut(input.updatedArticles);
        if (input.historyEntries.length > 0) {
          await this.db.stockHistoryEntries.bulkPut(
            input.historyEntries.map((entry) => ({
              ...entry,
              officeId: input.session.officeId,
              id: `${input.session.officeId}:${entry.sessionName}:${entry.articleId}`,
            })),
          );
        }
        await this.db.finalizedSessionResults.put({
          sessionId: input.session.id,
          review: input.review,
          snapshot: input.snapshot,
        });
      },
    );
  }

  async getFinalizedSessionResult(sessionId: string): Promise<FinalizedSessionResult | undefined> {
    return this.db.finalizedSessionResults.get(sessionId);
  }

  /**
   * Sprint 3.3 §5: alles in ÉÉN Dexie-transactie, zelfde discipline als
   * `finalizeSession` hierboven — faalt één van de schrijfacties, dan blijft
   * de sessie gewoon volledig bestaan (nooit een half verwijderde sessie).
   */
  async deleteSession(input: DeleteSessionInput): Promise<void> {
    const sheetId = `${input.officeId}:${input.sessionName}`;
    await this.db.transaction(
      "rw",
      [
        this.db.sessions,
        this.db.countEntries,
        this.db.locationSessionStatuses,
        this.db.finalizedSessionResults,
        this.db.historicalSheets,
        this.db.stockHistoryEntries,
        this.db.articles,
      ],
      async () => {
        await this.db.sessions.delete(input.sessionId);
        await this.db.countEntries.where("sessionId").equals(input.sessionId).delete();
        await this.db.locationSessionStatuses.where("sessionId").equals(input.sessionId).delete();
        await this.db.finalizedSessionResults.delete(input.sessionId);

        // Enkel de eigen, door DEZE sessie gegenereerde historische sheet
        // verwijderen — nooit een geïmporteerde sheet die toevallig dezelfde
        // naam draagt (sessionId: null of een ANDERE sessie).
        const sheet = await this.db.historicalSheets.get(sheetId);
        if (sheet && sheet.sessionId === input.sessionId) {
          await this.db.historicalSheets.delete(sheetId);
        }

        await this.db.stockHistoryEntries
          .where("officeId")
          .equals(input.officeId)
          .and((entry) => entry.sessionName === input.sessionName)
          .delete();

        if (input.updatedArticles.length > 0) {
          await this.db.articles.bulkPut(input.updatedArticles);
        }
      },
    );
  }

  async deleteHistoricalSnapshot(officeId: string, sessionName: string): Promise<void> {
    const sheetId = `${officeId}:${sessionName}`;
    await this.db.transaction(
      "rw",
      [this.db.historicalSheets, this.db.stockHistoryEntries],
      async () => {
        await this.db.historicalSheets.delete(sheetId);
        await this.db.stockHistoryEntries
          .where("officeId")
          .equals(officeId)
          .and((entry) => entry.sessionName === sessionName)
          .delete();
      },
    );
  }

  async cancelSession(sessionId: string, reason: string | null = null): Promise<void> {
    await this.db.sessions.update(sessionId, {
      status: "CANCELLED",
      cancelledAt: new Date().toISOString(),
      cancelReason: reason,
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

  async saveArticleLocationAssignments(assignments: ArticleLocationAssignment[]): Promise<void> {
    if (assignments.length === 0) return;
    await this.db.assignments.bulkPut(assignments);
  }

  async getArticleLocationAssignments(officeId: string): Promise<ArticleLocationAssignment[]> {
    return this.db.assignments.where("officeId").equals(officeId).toArray();
  }

  async getLocationSessionStatuses(sessionId: string): Promise<LocationSessionStatus[]> {
    return this.db.locationSessionStatuses.where("sessionId").equals(sessionId).toArray();
  }

  async saveLocationSessionStatus(status: LocationSessionStatus): Promise<void> {
    await this.db.locationSessionStatuses.put(status);
  }

  async getSelectedOfficeId(): Promise<string | undefined> {
    const row = await this.db.appState.get("singleton");
    return row?.selectedOfficeId;
  }

  async setSelectedOfficeId(officeId: string): Promise<void> {
    await this.db.appState.put({ id: "singleton", selectedOfficeId: officeId });
  }

  async saveHistoricalSheetSnapshot(record: HistoricalSheetRecord): Promise<void> {
    await this.db.historicalSheets.put({ ...record, id: `${record.officeId}:${record.sheetName}` });
  }

  async getHistoricalSheetSnapshots(officeId: string): Promise<HistoricalSheetRecord[]> {
    const rows = await this.db.historicalSheets.where("officeId").equals(officeId).toArray();
    return rows.map(({ id: _id, ...record }) => record);
  }

  async saveStockHistoryEntries(officeId: string, entries: StockHistoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.stockHistoryEntries.bulkPut(
      entries.map((entry) => ({
        ...entry,
        officeId,
        id: `${officeId}:${entry.sessionName}:${entry.articleId}`,
      })),
    );
  }

  async getStockHistoryEntries(officeId: string): Promise<StockHistoryEntry[]> {
    const rows = await this.db.stockHistoryEntries.where("officeId").equals(officeId).toArray();
    return rows.map(({ id: _id, officeId: _officeId, ...entry }) => entry);
  }

  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    if (categories.length === 0) return;
    await this.db.productCategories.bulkPut(categories);
  }

  async getProductCategories(): Promise<ProductCategory[]> {
    return this.db.productCategories.toArray();
  }

  async deleteProductCategory(categoryId: string): Promise<void> {
    await this.db.productCategories.delete(categoryId);
  }
}
