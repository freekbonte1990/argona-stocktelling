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
} from "../ports/CountingRepository";
import type { CentralHistoryStatus } from "../../domain/centralHistoryFile";
import type { CentralMasterApplyPlan, CentralMasterStatus } from "../../domain/centralMasterFile";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";

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
  private locationSessionStatuses = new Map<string, LocationSessionStatus>();

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
  async getAllArticles(): Promise<Article[]> {
    return Array.from(this.articles.values());
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
  async cancelSession(sessionId: string, reason: string | null = null): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "CANCELLED";
      session.cancelledAt = new Date().toISOString();
      session.cancelReason = reason;
    }
  }

  private finalizedSessionResults = new Map<string, FinalizedSessionResult>();
  /**
   * Geen echte transactie nodig in deze in-memory testdouble (alles is
   * synchroon/in het geheugen, er kan hier geen gedeeltelijke schrijving
   * optreden) — schrijft gewoon alle vier onderdelen na elkaar weg, exact
   * zoals de echte Dexie-transactie dat atomisch zou doen.
   */
  async finalizeSession(input: FinalizeSessionInput): Promise<void> {
    this.sessions.set(input.session.id, input.session);
    for (const article of input.updatedArticles) this.articles.set(article.id, article);
    await this.saveStockHistoryEntries(input.session.officeId, input.historyEntries);
    this.finalizedSessionResults.set(input.session.id, {
      sessionId: input.session.id,
      review: input.review,
      snapshot: input.snapshot,
    });
  }
  async getFinalizedSessionResult(sessionId: string): Promise<FinalizedSessionResult | undefined> {
    return this.finalizedSessionResults.get(sessionId);
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    this.sessions.delete(input.sessionId);
    for (const [id, entry] of this.entries) {
      if (entry.sessionId === input.sessionId) this.entries.delete(id);
    }
    for (const [id, status] of this.locationSessionStatuses) {
      if (status.sessionId === input.sessionId) this.locationSessionStatuses.delete(id);
    }
    this.finalizedSessionResults.delete(input.sessionId);

    const sheetKey = `${input.officeId}:${input.sessionName}`;
    const sheet = this.historicalSheets.get(sheetKey);
    if (sheet && sheet.sessionId === input.sessionId) {
      this.historicalSheets.delete(sheetKey);
    }
    for (const [key, entry] of this.stockHistoryEntries) {
      if (entry.officeId === input.officeId && entry.sessionName === input.sessionName) {
        this.stockHistoryEntries.delete(key);
      }
    }

    for (const article of input.updatedArticles) this.articles.set(article.id, article);
  }

  async deleteHistoricalSnapshot(officeId: string, sessionName: string): Promise<void> {
    this.historicalSheets.delete(`${officeId}:${sessionName}`);
    for (const [key, entry] of this.stockHistoryEntries) {
      if (entry.officeId === officeId && entry.sessionName === sessionName) {
        this.stockHistoryEntries.delete(key);
      }
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
  async saveArticleLocationAssignments(assignments: ArticleLocationAssignment[]): Promise<void> {
    for (const assignment of assignments) this.assignments.set(assignment.id, assignment);
  }
  async getArticleLocationAssignments(officeId: string): Promise<ArticleLocationAssignment[]> {
    return Array.from(this.assignments.values()).filter((a) => a.officeId === officeId);
  }

  async getLocationSessionStatuses(sessionId: string): Promise<LocationSessionStatus[]> {
    return Array.from(this.locationSessionStatuses.values()).filter(
      (s) => s.sessionId === sessionId,
    );
  }
  async saveLocationSessionStatus(status: LocationSessionStatus): Promise<void> {
    this.locationSessionStatuses.set(status.id, status);
  }

  private selectedOfficeId: string | undefined;
  async getSelectedOfficeId(): Promise<string | undefined> {
    return this.selectedOfficeId;
  }
  async setSelectedOfficeId(officeId: string): Promise<void> {
    this.selectedOfficeId = officeId;
  }

  private historicalSheets = new Map<string, HistoricalSheetRecord>();
  async saveHistoricalSheetSnapshot(record: HistoricalSheetRecord): Promise<void> {
    this.historicalSheets.set(`${record.officeId}:${record.sheetName}`, record);
  }
  async getHistoricalSheetSnapshots(officeId: string): Promise<HistoricalSheetRecord[]> {
    return Array.from(this.historicalSheets.values()).filter((r) => r.officeId === officeId);
  }

  private stockHistoryEntries = new Map<string, StockHistoryEntry & { officeId: string }>();
  async saveStockHistoryEntries(officeId: string, entries: StockHistoryEntry[]): Promise<void> {
    for (const entry of entries) {
      this.stockHistoryEntries.set(`${officeId}:${entry.sessionName}:${entry.articleId}`, {
        ...entry,
        officeId,
      });
    }
  }
  async getStockHistoryEntries(officeId: string): Promise<StockHistoryEntry[]> {
    return Array.from(this.stockHistoryEntries.values())
      .filter((e) => e.officeId === officeId)
      .map(({ officeId: _officeId, ...entry }) => entry);
  }

  private productCategories = new Map<string, ProductCategory>();
  async saveProductCategories(categories: ProductCategory[]): Promise<void> {
    for (const category of categories) this.productCategories.set(category.id, category);
  }
  async getProductCategories(): Promise<ProductCategory[]> {
    return Array.from(this.productCategories.values());
  }
  async deleteProductCategory(categoryId: string): Promise<void> {
    this.productCategories.delete(categoryId);
  }

  private centralHistoryStatuses = new Map<string, CentralHistoryStatus>();
  async getCentralHistoryStatus(officeId: string): Promise<CentralHistoryStatus | undefined> {
    const status = this.centralHistoryStatuses.get(officeId);
    return status ? { ...status, centralSessionIds: [...status.centralSessionIds] } : undefined;
  }
  async saveCentralHistoryStatus(status: CentralHistoryStatus): Promise<void> {
    this.centralHistoryStatuses.set(status.officeId, { ...status, centralSessionIds: [...status.centralSessionIds] });
  }


  private centralMasterStatuses = new Map<string, CentralMasterStatus>();
  async getCentralMasterStatus(officeId: string): Promise<CentralMasterStatus | undefined> {
    const status = this.centralMasterStatuses.get(officeId);
    return status ? structuredClone(status) : undefined;
  }
  async saveCentralMasterStatus(status: CentralMasterStatus): Promise<void> {
    this.centralMasterStatuses.set(status.officeId, structuredClone(status));
  }
  async applyCentralMaster(plan: CentralMasterApplyPlan): Promise<void> {
    this.offices.set(plan.office.id, plan.office);
    await this.saveProductCategories(plan.categories);
    await this.saveArticles(plan.articles);
    await this.saveArticles(plan.otherOfficeArticles);
    for (const id of plan.categoryIdsToDelete) this.productCategories.delete(id);
    await this.saveArticleLocationAssignments(plan.assignments);
    this.importMeta.set(plan.importMeta.officeId, plan.importMeta);
    if (plan.selectOffice) this.selectedOfficeId = plan.office.id;
    await this.saveCentralMasterStatus(plan.status);
  }
}
