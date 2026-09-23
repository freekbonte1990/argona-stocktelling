import { buildNextPreviousCounts, computeSessionReview } from "../../domain/review";
import type { SessionReviewSummary } from "../../domain/review";
import {
  buildHistoryEntriesFromSnapshot,
  buildSessionSnapshot,
  mergeHistoryEntries,
} from "../../domain/stockSnapshot";
import type { StockSnapshot } from "../../domain/stockSnapshot";
import type { CountingRepository } from "../ports/CountingRepository";
import type { ExportedFile, StockResultExporter } from "../ports/StockResultExporter";

/**
 * Gegooid door `exportSessionResults` wanneer de deterministische naam van
 * het nieuwe tellingtabblad (spec: afgeleid uit `CountSession.type` +
 * `completedAt`) al bezet is door EEN ANDERE sessie of een geïmporteerde
 * historische tab (spec: "behandel dit als een conflict en overschrijf niet
 * stilletjes"). Een HERHAALDE export van DEZELFDE sessie is bewust GEEN
 * conflict — zie `exportSessionResults`s hergebruiklogica hieronder.
 */
export class SheetNameConflictError extends Error {
  readonly sheetName: string;

  constructor(sheetName: string) {
    super(
      `Er bestaat al een tellingtabblad met de naam "${sheetName}" (van een andere telling of import). ` +
        "Dit tabblad wordt nooit stilzwijgend overschreven.",
    );
    this.name = "SheetNameConflictError";
    this.sheetName = sheetName;
  }
}

/**
 * Aanvulling op `SheetNameConflictError`: hoe de gebruiker een naamconflict
 * wil oplossen, expliciet doorgegeven aan een HERHAALDE aanroep van
 * `exportSessionResults` (spec: "kan je niet vragen om te overschrijven of
 * een andere naam te geven?"). Zonder deze parameter blijft het gedrag
 * ongewijzigd: een conflict gooit gewoon `SheetNameConflictError`, en de UI
 * beslist dan zelf — via deze parameter — hoe opnieuw te proberen.
 *   overwrite -> het bestaande tabblad (van de andere telling/import) wordt
 *                bewust vervangen door de verse export van DEZE sessie.
 *   rename    -> deze export gebruikt `sheetName` in plaats van de
 *                standaardnaam (voor het tabblad zelf én de HISTORIE-regels
 *                van deze sessie) — het botsende tabblad blijft ongemoeid.
 */
export type SheetNameConflictResolution =
  | { action: "overwrite" }
  | { action: "rename"; sheetName: string };

/**
 * Gegooid door `exportSessionResults` voor een CANCELLED sessie (sessielogica-
 * fix, punt 7: "de recent gebouwde rolling-archive-functionaliteit mag niet
 * wijzigen — een CANCELLED sessie maakt geen named snapshot-tab, voegt niets
 * toe aan HISTORIE, en wordt nooit als vorige fysieke telling gebruikt").
 *
 * UPDATE (data-integriteit-sprint §2): een ACTIEVE sessie exporteert
 * inmiddels NIET meer tussentijds — zie `ActiveSessionExportError` hieronder.
 * Enkel een COMPLETED sessie mag nog officieel geëxporteerd worden.
 */
export class CancelledSessionExportError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Sessie ${sessionId} is geannuleerd en kan niet naar het rollend archief geëxporteerd worden.`);
    this.name = "CancelledSessionExportError";
    this.sessionId = sessionId;
  }
}

/**
 * Data-integriteit-sprint §2: gegooid door `exportSessionResults` voor een
 * nog LOPENDE (ACTIVE) sessie. Voordien kon een tussentijdse export van een
 * nog niet afgeronde sessie toch al een benoemd tellingtabblad/HISTORIE-
 * regels/een `previousCount`-update produceren — dat kon een "concept"-
 * export laten doorgaan voor een officiële, definitieve telling. Er is
 * BEWUST geen apart "concept-export"-pad gebouwd (spec: "simpelweg
 * blokkeren") — een ACTIEVE sessie moet eerst via "Telling afronden"
 * (`CountSessionService#completeSession`/`completeSessionWithOutstandingArticles`)
 * COMPLETED worden vóór ze officieel geëxporteerd kan worden.
 */
export class ActiveSessionExportError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Sessie ${sessionId} is nog niet afgerond (ACTIEF) en kan niet naar het rollend archief ` +
        'geëxporteerd worden — rond de telling eerst af via "Telling afronden".',
    );
    this.name = "ActiveSessionExportError";
    this.sessionId = sessionId;
  }
}

/**
 * Orkestreert de export van tellingsresultaten: haalt alles op via de
 * `CountingRepository`, berekent de review (domain/review.ts) en het
 * rollend-stockarchief (domain/stockSnapshot.ts — volledige snapshot +
 * HISTORIE-log), en geeft dat alles door aan een `StockResultExporter`
 * (vandaag: `ExcelStockResultExporter`).
 *
 * Kent zelf geen Excel- of IndexedDB-specifieke kennis — enkel de ports en
 * domain/. Een latere `EBuddyStockResultExporter` kan hier plug-and-play
 * achter gezet worden (zie docs/ARCHITECTURE.md).
 *
 * Data-integriteit-sprint §3: sinds deze sprint is dit enkel nog een PURE
 * serialisatie van het reeds bevroren resultaat van
 * `CountSessionService#finalize` (review + StockSnapshot + HISTORIE) — geen
 * enkele aanroep hier wijzigt nog businessstatus (`Article.previousCount`,
 * HISTORIE). De enige write die hier nog gebeurt is het cachen van de ruwe,
 * benoemde tellingtab-rijen (zuivere presentatie, voor byte-identieke
 * herexport) — behalve op het backward-compatibele legacy-terugvalpad voor
 * sessies die al COMPLETED waren vóór deze sprint bestond (zie
 * `exportSessionResults`).
 */
export class ExportService {
  private readonly repository: CountingRepository;
  private readonly exporter: StockResultExporter;

  constructor(repository: CountingRepository, exporter: StockResultExporter) {
    this.repository = repository;
    this.exporter = exporter;
  }

  async exportSessionResults(
    sessionId: string,
    resolution?: SheetNameConflictResolution,
  ): Promise<ExportedFile> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    if (session.status === "CANCELLED") {
      throw new CancelledSessionExportError(sessionId);
    }
    // Data-integriteit-sprint §2: een officiële export mag enkel voor een
    // reeds AFGERONDE (COMPLETED) sessie — er is bewust geen apart "concept-
    // export"-pad, dit blokkeert simpelweg (zie ActiveSessionExportError).
    if (session.status === "ACTIVE") {
      throw new ActiveSessionExportError(sessionId);
    }

    const [office, allArticles, assignments, existingSheets, existingHistory, finalized] = await Promise.all([
      this.repository.getOffice(session.officeId),
      this.repository.getArticles(session.officeId),
      this.repository.getArticleLocationAssignments(session.officeId),
      this.repository.getHistoricalSheetSnapshots(session.officeId),
      this.repository.getStockHistoryEntries(session.officeId),
      this.repository.getFinalizedSessionResult(sessionId),
    ]);
    if (!office) {
      throw new Error(`Kantoor ${session.officeId} niet gevonden.`);
    }

    // Data-integriteit-sprint §3: PURE serialisatie van het reeds bevroren
    // resultaat van `CountSessionService#finalize` — nooit hier opnieuw
    // berekend uit intussen mogelijk gewijzigde levende data (bv. een
    // kostprijscorrectie via het Artikeldetailscherm, of een latere sessie
    // die `Article.previousCount` intussen verder ophoogde). Dit garandeert
    // dat een herhaalde export van dezelfde COMPLETED sessie byte-voor-byte
    // identiek blijft.
    //
    // Backward-compatibele terugval (§10 — geen dataverlies bij upgrade):
    // een sessie die al COMPLETED was VÓÓR deze sprint bestond, heeft nooit
    // een `FinalizedSessionResult` gekregen (die tabel bestond nog niet).
    // Voor die (oude) sessies herberekenen we hier — puur, met exact
    // dezelfde functies als `finalize` gebruikt — en passen we, enkel voor
    // DIT legacy-pad, ook nog de oude previousCount/HISTORIE-schrijfactie toe
    // (verderop) zodat zo'n sessie, ook na de upgrade, bij haar eerste export
    // nog steeds correct bijdraagt aan de volgende telcyclus.
    const isLegacyFallback = !finalized;
    let review: SessionReviewSummary;
    let baseSnapshot: StockSnapshot;
    if (finalized) {
      review = finalized.review;
      baseSnapshot = finalized.snapshot;
    } else {
      const [entries, locationStatuses] = await Promise.all([
        this.repository.getCountEntries(sessionId),
        this.repository.getLocationSessionStatuses(sessionId),
      ]);
      review = computeSessionReview(session, allArticles, office.locations, entries, locationStatuses);
      baseSnapshot = buildSessionSnapshot(session, allArticles, review);
    }

    // Aanvulling ("kan je niet vragen om te overschrijven of een andere naam
    // te geven?"): bij `rename` gebruiken we voortaan overal — het tabblad,
    // de HISTORIE-regels, de opgeslagen snapshot — de door de gebruiker
    // gekozen naam in plaats van de standaard afgeleide naam. `overwrite`
    // wijzigt de naam zelf niet, enkel de conflictcheck hieronder.
    let snapshot = baseSnapshot;
    if (resolution?.action === "rename") {
      const chosenName = resolution.sheetName.trim();
      if (chosenName.length === 0) {
        throw new Error("Geef een geldige naam op voor het tellingtabblad.");
      }
      snapshot = { ...baseSnapshot, sessionName: chosenName };
    }

    // Naamconflict: een ANDERE sessie of import bezet deze naam al. Een
    // herhaalde export van DEZELFDE sessie (hieronder `alreadyFrozen`) is
    // geen conflict — dat tabblad wordt gewoon hergebruikt. Bij expliciete
    // `overwrite`-bevestiging van de gebruiker gooien we niet, en het
    // botsende tabblad wordt hieronder (`otherHistoricalSheets`) bewust NIET
    // doorgegeven — het wordt vervangen door de verse export van deze sessie.
    // Een `rename` naar een naam die ZELF ook al bezet is, blijft wél een
    // conflict (met de nieuwe naam) — zo kan de gebruiker dat opnieuw oplossen.
    const conflictingSheet = existingSheets.find(
      (s) => s.sheetName === snapshot.sessionName && s.sessionId !== session.id,
    );
    if (conflictingSheet && resolution?.action !== "overwrite") {
      throw new SheetNameConflictError(snapshot.sessionName);
    }
    const alreadyFrozen = existingSheets.find(
      (s) => s.sheetName === snapshot.sessionName && s.sessionId === session.id,
    );

    // Data-integriteit-sprint §3: voor een sessie die al een
    // `FinalizedSessionResult` heeft (dus afgerond onder deze sprint's
    // code), staan de HISTORIE-regels van deze sessie al, onder haar
    // canonieke naam, in `existingHistory` — hier gewoon lezen, nooit
    // opnieuw afleiden/samenvoegen. Enkel het legacy-terugvalpad (een sessie
    // van vóór deze sprint, zie hierboven) moet dat hier nog, eenmalig, zelf
    // doen — altijd op basis van de canonieke `baseSnapshot`, nooit van een
    // eventueel door de gebruiker gekozen exportnaam (`rename` hierboven
    // wijzigt enkel de weergavenaam van het Excel-tabblad, nooit de
    // onderliggende HISTORIE-naamgeving).
    const historyEntries = isLegacyFallback
      ? mergeHistoryEntries(existingHistory, buildHistoryEntriesFromSnapshot(baseSnapshot, office.locations))
      : existingHistory;
    const otherHistoricalSheets = existingSheets
      .filter((s) => s.sheetName !== snapshot.sessionName)
      .map((s) => ({ sheetName: s.sheetName, rows: s.rows }));

    const exported = await this.exporter.exportResults({
      office,
      session,
      review,
      allArticles,
      assignments,
      snapshot,
      historicalSheets: otherHistoricalSheets,
      historyEntries,
      frozenSnapshotRows: alreadyFrozen?.rows,
    });

    if (exported.newHistoricalSheet) {
      // Zuiver presentatie-/serialisatiegeheugen (de ruwe Excel-rijen van het
      // NAMED tabblad van deze sessie) — géén businessstatus, blijft dus
      // altijd bewaard zodat een latere export dit tabblad byte-voor-byte
      // kan hergebruiken (`frozenSnapshotRows` hierboven), ook voor een
      // sessie met een `FinalizedSessionResult`.
      await this.repository.saveHistoricalSheetSnapshot({
        officeId: office.id,
        sessionId: session.id,
        sheetName: exported.newHistoricalSheet.sheetName,
        rows: exported.newHistoricalSheet.rows,
      });
    }

    // Data-integriteit-sprint §3: export mag geen businessstatus meer
    // wijzigen — `Article.previousCount` en de HISTORIE-log worden voortaan
    // uitsluitend door `CountSessionService#finalize` bijgewerkt, bij het
    // AFRONDEN van de sessie zelf, niet hier. Enkel het legacy-terugvalpad
    // (zie hierboven) behoudt hier nog het OUDE gedrag — en dan nog enkel bij
    // een VERSE export van het benoemde tabblad (`exported.newHistoricalSheet`
    // gezet), exact zoals vóór deze sprint: een herhaalde export van dezelfde
    // sessie mag haar eigen "Vorige telling" nooit alsnog laten verschuiven.
    if (isLegacyFallback && exported.newHistoricalSheet) {
      const nextPreviousCounts = buildNextPreviousCounts(allArticles, review.results);
      const updatedArticles = allArticles.map((article) => ({
        ...article,
        previousCount: nextPreviousCounts.get(article.id) ?? article.previousCount,
      }));
      await this.repository.saveArticles(updatedArticles);
      await this.repository.saveStockHistoryEntries(office.id, historyEntries);
    }

    return exported;
  }
}
