import type { SessionReviewSummary } from "../../domain/review";
import type { StockHistoryEntry, StockSnapshot } from "../../domain/stockSnapshot";
import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  LocationSessionStatus,
  Office,
} from "../../domain/types";

/** Metadata over de laatste import van een kantoor (voor traceerbaarheid op een sessie). */
export interface ImportMeta {
  officeId: string;
  sourceFileName: string;
  importedAt: string;
}

/**
 * Eén bevroren, historisch tellingtabblad (rollend Excelarchief) zoals
 * bewaard door deze repository: ofwel afkomstig uit een geïmporteerd bestand
 * (`sessionId: null` — de sessie die het produceerde is hier niet lokaal
 * gekend), ofwel zelf gegenereerd door `ExportService` bij het afronden/
 * exporteren van een sessie in DEZE repository (`sessionId` gezet). Dat
 * onderscheid is precies wat een herhaalde export van dezelfde sessie
 * (hergebruik, geen conflict) onderscheidt van een echte naamsbotsing met
 * een ANDERE sessie/import (conflict) — zie `ExportService`.
 */
export interface HistoricalSheetRecord {
  officeId: string;
  sessionId: string | null;
  sheetName: string;
  rows: unknown[][];
}

/**
 * Data-integriteit-sprint §3: het volledige, reeds berekende resultaat van
 * één finalisatie (`CountingRepository#finalizeSession`) — bewaard zodat
 * `ExportService` dit achteraf enkel hoeft te LEZEN en te serialiseren, nooit
 * opnieuw hoeft te berekenen. Dit garandeert dat een herhaalde export van
 * dezelfde COMPLETED sessie byte-voor-byte identiek blijft, ook wanneer de
 * levende artikelstam (bv. een kostprijscorrectie via het Artikeldetail-
 * scherm) intussen wijzigde — dat mag de reeds bevroren, historische
 * snapshot van deze sessie nooit meer beïnvloeden.
 */
export interface FinalizedSessionResult {
  sessionId: string;
  review: SessionReviewSummary;
  snapshot: StockSnapshot;
}

/**
 * Alles wat `CountSessionService#finalize` in ÉÉN transactie moet
 * wegschrijven bij het afronden van een sessie (data-integriteit-sprint §3):
 * de sessie zelf (reeds met status COMPLETED + completedAt gezet), de
 * bijgewerkte artikelstam (`Article.previousCount`, enkel gewijzigd waar
 * effectief fysiek geteld/bevestigd — zie `domain/review.ts#buildNextPreviousCounts`),
 * de volledige, samengevoegde HISTORIE-log, en het bevroren
 * `FinalizedSessionResult` (review + snapshot) voor latere, pure export.
 */
export interface FinalizeSessionInput {
  session: CountSession;
  updatedArticles: Article[];
  historyEntries: StockHistoryEntry[];
  review: SessionReviewSummary;
  snapshot: StockSnapshot;
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
  /**
   * Alle sessies van een kantoor (actief + afgerond), nieuwste eerst.
   * Nodig zodat afgeronde sessies raadpleegbaar blijven (spec v0.2 §4).
   */
  getSessionsForOffice(officeId: string): Promise<CountSession[]>;
  /**
   * LEGACY: rondt een sessie af zonder de finalisatielogica (data-
   * integriteit-sprint §3) — vervangen door `finalizeSession` hieronder.
   * `CountSessionService` roept dit niet meer aan (beide voltooiingspaden
   * gaan voortaan via `finalizeSession`, in ÉÉN transactie). Blijft enkel
   * bestaan voor interface-/backward-compatibiliteit; geen enkele aanroeper
   * in deze codebase gebruikt dit nog.
   */
  completeSession(sessionId: string): Promise<void>;
  /**
   * Data-integriteit-sprint §3: schrijft ALLES wat bij het afronden van een
   * sessie hoort in ÉÉN transactie weg (Dexie: `db.transaction('rw', [...])`)
   * — de sessie zelf, de bijgewerkte artikelstam, de samengevoegde HISTORIE,
   * en het bevroren `FinalizedSessionResult` (review + snapshot). Faalt één
   * onderdeel, dan wordt de volledige transactie teruggedraaid: nooit een
   * sessie die wel COMPLETED staat maar waarvan de artikelstam/HISTORIE niet
   * (volledig) bijgewerkt is, of omgekeerd.
   */
  finalizeSession(input: FinalizeSessionInput): Promise<void>;
  /**
   * Het bevroren resultaat van `finalizeSession` voor deze sessie — `undefined`
   * voor een sessie die nog niet gefinaliseerd is (nog ACTIVE), of voor een
   * sessie die vóór deze sprint al COMPLETED was (backward-compatible: die
   * heeft nooit een `FinalizedSessionResult` gehad). `ExportService` valt in
   * dat laatste geval terug op een verse (maar even pure) herberekening — zie
   * `ExportService#exportSessionResults`.
   */
  getFinalizedSessionResult(sessionId: string): Promise<FinalizedSessionResult | undefined>;
  /**
   * Annuleert een sessie (sessielogica-fix): zet status CANCELLED en
   * `cancelledAt`. Deze methode zelf voert geen validatie uit (bv. of de
   * sessie wel ACTIVE was) — dat is aan de aanroeper (CountSessionService).
   * Zodra CANCELLED, vindt `getActiveSession` deze sessie niet meer (die
   * filtert expliciet op status === "ACTIVE"), dus blokkeert ze geen nieuwe
   * sessie meer.
   */
  cancelSession(sessionId: string, reason?: string | null): Promise<void>;

  saveCountEntry(entry: CountEntry): Promise<void>;
  saveCountEntries(entries: CountEntry[]): Promise<void>;
  getCountEntries(sessionId: string): Promise<CountEntry[]>;

  saveArticleLocationAssignment(assignment: ArticleLocationAssignment): Promise<void>;
  /** Bulk-variant (v0.2.1 bulk locatiebeheer, Artikels-overzicht) — schrijft meerdere koppelingen in één keer. */
  saveArticleLocationAssignments(assignments: ArticleLocationAssignment[]): Promise<void>;
  getArticleLocationAssignments(officeId: string): Promise<ArticleLocationAssignment[]>;

  /**
   * Status per (sessie, locatie) — spec v0.2.1 §4: OPEN/COMPLETED, met
   * `completedAt`. Losstaand van `Location.active`: dit gaat over "is deze
   * locatie klaar VOOR DEZE SESSIE", niet over of de locatie zelf nog bestaat.
   */
  getLocationSessionStatuses(sessionId: string): Promise<LocationSessionStatus[]>;
  saveLocationSessionStatus(status: LocationSessionStatus): Promise<void>;

  /**
   * Welk kantoor de gebruiker laatst geselecteerd had (multi-kantoor
   * ondersteuning — zie HomePage's kantoorwisselaar). Puur een UI-voorkeur,
   * geen businessdata; overleeft wel een refresh/herstart.
   */
  getSelectedOfficeId(): Promise<string | undefined>;
  setSelectedOfficeId(officeId: string): Promise<void>;

  /**
   * Rollend stockarchief (spec): bewaart/leest de bevroren historische
   * tellingtabs van een kantoor. `saveHistoricalSheetSnapshot` is een upsert
   * op (officeId, sheetName) — een sheetnaam wordt nooit twee keer apart
   * bewaard, en de rijen van een reeds bewaarde sheet worden bij een nieuwe
   * `save`-aanroep bewust NIET overschreven door de aanroeper (zie
   * `ExportService`s conflict-/hergebruiklogica) — deze methode zelf voert
   * geen eigen validatie uit, dat is aan de aanroeper.
   */
  saveHistoricalSheetSnapshot(record: HistoricalSheetRecord): Promise<void>;
  getHistoricalSheetSnapshots(officeId: string): Promise<HistoricalSheetRecord[]>;

  /**
   * Rollend stockarchief (spec): de machinevriendelijke HISTORIE-log,
   * gededupliceerd op (sessionName, articleId) — zie
   * `domain/stockSnapshot.ts#mergeHistoryEntries`. `saveStockHistoryEntries`
   * vervangt de volledige, reeds samengevoegde lijst voor dit kantoor (de
   * samenvoeging zelf gebeurt in `ExportService`/`ImportService`, niet hier).
   */
  saveStockHistoryEntries(officeId: string, entries: StockHistoryEntry[]): Promise<void>;
  getStockHistoryEntries(officeId: string): Promise<StockHistoryEntry[]>;
}
