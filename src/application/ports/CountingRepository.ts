import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  Office,
} from "../../domain/types";

/** Metadata over de laatste import van een kantoor (voor traceerbaarheid op een sessie). */
export interface ImportMeta {
  officeId: string;
  sourceFileName: string;
  importedAt: string;
}

/**
 * Persistentie voor alles wat met tellen te maken heeft: kantoren/locaties,
 * artikelen, telsessies, individuele tellingen en geleerde artikel-locatie
 * koppelingen.
 *
 * Vandaag geïmplementeerd door IndexedDbCountingRepository (Dexie). Later
 * moet dit een EBuddyCountingRepository kunnen worden die tegen een API
 * praat, zonder dat services of UI-schermen wijzigen. Zie docs/ARCHITECTURE.md.
 */
export interface CountingRepository {
  saveOffice(office: Office): Promise<void>;
  getOffice(officeId: string): Promise<Office | undefined>;
  getAllOffices(): Promise<Office[]>;

  saveImportMeta(meta: ImportMeta): Promise<void>;
  getImportMeta(officeId: string): Promise<ImportMeta | undefined>;

  saveArticles(articles: Article[]): Promise<void>;
  getArticles(officeId: string): Promise<Article[]>;

  createSession(session: CountSession): Promise<void>;
  getSession(sessionId: string): Promise<CountSession | undefined>;
  getActiveSession(officeId: string): Promise<CountSession | undefined>;
  completeSession(sessionId: string): Promise<void>;

  saveCountEntry(entry: CountEntry): Promise<void>;
  saveCountEntries(entries: CountEntry[]): Promise<void>;
  getCountEntries(sessionId: string): Promise<CountEntry[]>;

  saveArticleLocationAssignment(assignment: ArticleLocationAssignment): Promise<void>;
  getArticleLocationAssignments(officeId: string): Promise<ArticleLocationAssignment[]>;

  /**
   * Welk kantoor de gebruiker laatst geselecteerd had (multi-kantoor
   * ondersteuning — zie HomePage's kantoorwisselaar). Puur een UI-voorkeur,
   * geen businessdata; overleeft wel een refresh/herstart.
   */
  getSelectedOfficeId(): Promise<string | undefined>;
  setSelectedOfficeId(officeId: string): Promise<void>;
}
