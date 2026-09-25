import { buildSessionAnalysis } from "../../domain/analysis";
import type { SessionAnalysis } from "../../domain/analysis";
import { computeSessionReview } from "../../domain/review";
import { buildSessionSnapshot } from "../../domain/stockSnapshot";
import type { CountingRepository } from "../ports/CountingRepository";

/** Gegooid door `getSessionAnalysis` voor een sessie die niet (meer) bestaat. */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Sessie ${sessionId} niet gevonden.`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Sprint 2 §1/§12: "Analyse telling" is een strikt alleen-lezen view voor
 * een AFGERONDE sessie — een nog lopende (ACTIVE) sessie heeft nog geen
 * bevroren resultaat en hoort bij `ReviewPage` (de "Telling afronden"-flow),
 * een geannuleerde (CANCELLED) sessie was nooit een officiële telling (zie
 * `docs/DATA_MODEL.md`) en heeft dus ook geen analyse.
 */
export class SessionNotAnalyzableError extends Error {
  readonly sessionId: string;
  readonly actualStatus: string;

  constructor(sessionId: string, actualStatus: string) {
    super(
      `Sessie ${sessionId} heeft status ${actualStatus} — enkel een AFGERONDE (COMPLETED) sessie heeft een historische analyse.`,
    );
    this.name = "SessionNotAnalyzableError";
    this.sessionId = sessionId;
    this.actualStatus = actualStatus;
  }
}

/**
 * Orkestreert de "Analyse telling"-view (Sprint 2 — Historical Count
 * Analysis): haalt het bevroren `FinalizedSessionResult` op en geeft dat,
 * puur, door aan `domain/analysis.ts#buildSessionAnalysis`.
 *
 * Architectuurregel (spec §13, zelfde patroon als `ExportService`): dit is
 * de ENIGE application-laag die hiervoor live `Article`-data zou mogen
 * aanraken, en zelfs hier gebeurt dat uitsluitend in het backward-
 * compatibele LEGACY-terugvalpad hieronder (een sessie afgerond vóór de
 * data-integriteit-sprint, die dus nooit een `FinalizedSessionResult`
 * gekregen heeft) — voor elke andere/nieuwere sessie wordt UITSLUITEND het
 * reeds bevroren resultaat gelezen, nooit herberekend uit intussen mogelijk
 * gewijzigde levende artikelen.
 */
export class AnalysisService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  async getSessionAnalysis(sessionId: string): Promise<SessionAnalysis> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    if (session.status !== "COMPLETED") {
      throw new SessionNotAnalyzableError(sessionId, session.status);
    }

    const [office, finalized] = await Promise.all([
      this.repository.getOffice(session.officeId),
      this.repository.getFinalizedSessionResult(sessionId),
    ]);
    if (!office) {
      throw new Error(`Kantoor ${session.officeId} niet gevonden.`);
    }

    if (finalized) {
      return buildSessionAnalysis(finalized.snapshot, finalized.review, office.locations);
    }

    // Legacy-terugvalpad (zie ExportService voor hetzelfde patroon): een
    // sessie die COMPLETED was vóór `FinalizedSessionResult` bestond, heeft
    // nooit een bevroren snapshot/review gekregen. We herberekenen hier
    // eenmalig, puur, uit de nog steeds bewaarde ruwe entries — dit gebruikt
    // bewust de HUIDIGE levende artikelstam, want er is voor zo'n sessie
    // simpelweg geen bevroren alternatief; dit wordt gerapporteerd als een
    // gekende historische beperking (spec-rapportpunt 6).
    const [articles, entries, locationStatuses] = await Promise.all([
      this.repository.getArticles(session.officeId),
      this.repository.getCountEntries(sessionId),
      this.repository.getLocationSessionStatuses(sessionId),
    ]);
    const review = computeSessionReview(session, articles, office.locations, entries, locationStatuses);
    const snapshot = buildSessionSnapshot(session, articles, review);
    return buildSessionAnalysis(snapshot, review, office.locations);
  }
}
