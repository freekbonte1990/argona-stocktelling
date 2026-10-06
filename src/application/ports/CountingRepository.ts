import type { CentralHistoryStatus } from "../../domain/centralHistoryFile";
import type { SessionReviewSummary } from "../../domain/review";
import type { StockHistoryEntry, StockSnapshot } from "../../domain/stockSnapshot";
import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  LocationSessionStatus,
  Office,
  ProductCategory,
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
 * Sprint 3.3 §5 (veilig verwijderen van tellingen): alles wat
 * `CountSessionService#deleteSession` in ÉÉN transactie moet wegschrijven om
 * een afgeronde (COMPLETED) sessie volledig en veilig te verwijderen —
 * `sessionName` is de bevroren snapshotnaam van de sessie (spec §5, om haar
 * eigen HISTORIE-regels en eventuele zelf-gegenereerde historische sheet
 * terug te vinden), `updatedArticles` de reeds herberekende
 * `previousCount`-baselines (zie `domain/sessionDeletion.ts`,
 * leeg wanneer er niets te herberekenen viel, bv. een legacy sessie zonder
 * bevroren snapshot).
 */
export interface DeleteSessionInput {
  officeId: string;
  sessionId: string;
  sessionName: string;
  updatedArticles: Article[];
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
  /**
   * Sprint 3.2.1-architectuurfix: alle artikelen van ALLE kantoren samen.
   * Nodig omdat `ProductCategory` nu bedrijfsbreed/globaal is — of een
   * categorie nog "in gebruik" is (spec §6, `canHardDeleteProductCategory`/
   * `mergeCategories`) moet dus over alle kantoren heen gecontroleerd worden,
   * niet enkel binnen het momenteel geselecteerde kantoor. Zelfde precedent
   * als `getAllOffices()` hierboven.
   */
  getAllArticles(): Promise<Article[]>;

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
   * Sprint 3.3 §5: verwijdert een afgeronde (COMPLETED) app-telling volledig
   * en cascadeert naar alle afgeleide data — de sessie zelf, haar
   * CountEntries, haar LocationSessionStatuses, haar FinalizedSessionResult,
   * haar eigen HISTORIE-regels (`stockHistoryEntries`, gematcht op
   * `(officeId, sessionName)`), en — enkel wanneer de bewaarde
   * `HistoricalSheetRecord` op die (officeId, sessionName) ECHT door DEZE
   * sessie zelf gegenereerd werd (`record.sessionId === input.sessionId`) —
   * ook die sheet. Een geïmporteerde sheet die toevallig dezelfde naam draagt
   * (`sessionId: null` of een ANDERE sessie) wordt hierdoor nooit per
   * ongeluk meeverwijderd. Schrijft ook meteen `input.updatedArticles` weg
   * (de reeds herberekende `previousCount`-baselines, zie
   * `domain/sessionDeletion.ts`) — alles in ÉÉN transactie: verwijdert een
   * onderdeel, maar wordt de transactie onderbroken, dan blijft de sessie
   * gewoon volledig ongewijzigd bestaan (nooit een half verwijderde sessie).
   * Verwijdert NOOIT artikelen/mastergegevens zelf — enkel hun
   * `previousCount` kan wijzigen.
   */
  deleteSession(input: DeleteSessionInput): Promise<void>;
  /**
   * Sprint 3.3 §5: verwijdert één legacy historische snapshot (`LEGACY_IMPORT`,
   * item 3) — eenvoudiger dan `deleteSession` hierboven: een legacy snapshot
   * heeft nooit een `FinalizedSessionResult`, `CountEntry` of
   * `LocationSessionStatus`, en beïnvloedt (per ontwerp, spec §3/§4) nooit
   * `Article.previousCount` — dus geen artikel-herberekening nodig. Verwijdert
   * enkel de bewaarde `HistoricalSheetRecord` (indien aanwezig) en haar
   * HISTORIE-regels voor deze (officeId, sessionName).
   */
  deleteHistoricalSnapshot(officeId: string, sessionName: string): Promise<void>;
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

  /**
   * Sprint 3.2 — Dynamic Product Categories: bulk-upsert, zelfde patroon als
   * `saveArticles`. `ProductCategoryService` is de enige aanroeper — geen UI-
   * scherm schrijft hier rechtstreeks naartoe.
   *
   * Sprint 3.2.1-architectuurfix: `ProductCategory` is bedrijfsbreed/globaal
   * (geen `officeId` meer) — `getProductCategories` leest daarom ALTIJD de
   * volledige, gedeelde lijst, ongeacht welk kantoor actief is.
   */
  saveProductCategories(categories: ProductCategory[]): Promise<void>;
  getProductCategories(): Promise<ProductCategory[]>;
  /**
   * Hard verwijderen van een NOOIT-gebruikte categorie (spec §6) — de
   * aanroeper (`ProductCategoryService`/`domain/productCategory.ts#
   * canHardDeleteProductCategory`) garandeert vooraf dat ze niet meer aan
   * enig artikel toegewezen is.
   */
  deleteProductCategory(categoryId: string): Promise<void>;

  /**
   * Centrale read-only historiek: status van de laatste sync per kantoor
   * (laatste succes, discrete waarschuwing, en de lokale sessies die
   * centraal bestaan — zie `CentralHistoryStatus`). Puur app-metadata, geen
   * businessdata; `saveCentralHistoryStatus` is een upsert op `officeId`.
   */
  getCentralHistoryStatus(officeId: string): Promise<CentralHistoryStatus | undefined>;
  saveCentralHistoryStatus(status: CentralHistoryStatus): Promise<void>;
  /**
   * Toestel-lokale toegangscode voor de centrale bron (vandaag: het beveiligde
   * Vercel-endpoint). `null`/`undefined` = niet ingesteld. Wordt nooit
   * meegeëxporteerd naar Excel of gelogd.
   */
  getCentralHistoryAccessCode(): Promise<string | undefined>;
  setCentralHistoryAccessCode(code: string | null): Promise<void>;
}
