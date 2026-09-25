import {
  buildSessionComparison,
  type ComparisonSnapshotInput,
  type ReliableHistoryEntry,
  type SessionComparison,
} from "../../domain/comparison";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
import type { CountSessionType } from "../../domain/types";
import type { CountingRepository } from "../ports/CountingRepository";

export class ComparisonSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Sessie ${sessionId} niet gevonden.`);
    this.name = "ComparisonSessionNotFoundError";
  }
}

/**
 * Sprint 3 §3 (legacy data): gegooid wanneer een gekozen sessie (A of B) wel
 * COMPLETED is, maar GEEN bevroren `FinalizedSessionResult` heeft — een
 * sessie afgerond vóór de data-integriteit-sprint. `getComparisonOptions`
 * hieronder sluit zulke sessies al uit de keuzelijst uit, dus dit is puur
 * een defensieve tweede check (bv. tegen een verouderde/foutieve route).
 */
export class ComparisonNotAvailableError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Sessie ${sessionId} heeft geen betrouwbare, bevroren historische data (legacy) en kan niet gebruikt worden voor een vergelijking.`,
    );
    this.name = "ComparisonNotAvailableError";
    this.sessionId = sessionId;
  }
}

export class ComparisonOfficeMismatchError extends Error {
  constructor() {
    super("Beide tellingen moeten van hetzelfde kantoor zijn.");
    this.name = "ComparisonOfficeMismatchError";
  }
}

export interface ComparisonSessionOption {
  sessionId: string;
  sessionName: string;
  sessionType: CountSessionType;
  completedAt: string | null;
}

/**
 * Sprint 3 — Vergelijking tussen stocktellingen. Orkestreert de
 * "Vergelijken"-view: haalt de bevroren `FinalizedSessionResult` van twee
 * COMPLETED sessies van hetzelfde kantoor op, plus de bredere betrouwbare
 * kantoorhistoriek (voor de opeenvolgende-tellingen-berekening, spec §8), en
 * geeft dat puur door aan `domain/comparison.ts#buildSessionComparison`.
 *
 * Architectuurregel (spec §14, zelfde patroon als `AnalysisService`): dit is
 * strikt ALLEEN-LEZEN — geen enkele methode hier schrijft ooit iets weg.
 */
export class ComparisonService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  /**
   * Sprint 3 §3 (legacy data): enkel COMPLETED sessies MET een bevroren
   * `FinalizedSessionResult` zijn selecteerbaar als telling A/B — een sessie
   * zonder frozen resultaat zou een financiële vergelijking stilzwijgend op
   * actuele, mogelijk intussen gewijzigde artikeldata baseren, wat spec §3
   * expliciet verbiedt. Gekozen oplossing (spec §3, eerste/voorkeursoptie):
   * zulke sessies VOLLEDIG uitsluiten van de A/B-keuzelijst, in plaats van ze
   * te tonen met een "Beperkte historische data"-label — dat zou alsnog een
   * (deels) op actuele data gebaseerde vergelijking suggereren, wat precies
   * is wat vermeden moet worden. `hasLegacySessions` laat de UI weten dat er
   * oudere tellingen verborgen zijn, zodat de gebruiker niet in verwarring
   * raakt over "ontbrekende" tellingen in de lijst.
   */
  async getComparisonOptions(
    officeId: string,
  ): Promise<{ sessions: ComparisonSessionOption[]; hasLegacySessions: boolean }> {
    const sessions = await this.repository.getSessionsForOffice(officeId);
    const completed = sessions.filter((s) => s.status === "COMPLETED");
    const finalizedResults = await Promise.all(
      completed.map((s) => this.repository.getFinalizedSessionResult(s.id)),
    );

    const options: ComparisonSessionOption[] = [];
    let hasLegacySessions = false;
    completed.forEach((session, index) => {
      if (!finalizedResults[index]) {
        hasLegacySessions = true;
        return;
      }
      options.push({
        sessionId: session.id,
        sessionName: sessionSnapshotName(session),
        sessionType: session.type,
        completedAt: session.completedAt,
      });
    });
    options.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

    return { sessions: options, hasLegacySessions };
  }

  /**
   * Spec §2 — default selectie bij het openen van "Vergelijken" vanuit een
   * concrete sessie: B = die sessie, A = de onmiddellijk voorafgaande
   * bruikbare (niet-legacy) afgeronde telling. `sessionIdA` is `null` wanneer
   * er geen eerdere bruikbare telling bestaat — de gebruiker kiest dan zelf.
   */
  async getDefaultSelection(
    officeId: string,
    fromSessionId: string,
  ): Promise<{ sessionIdA: string | null; sessionIdB: string }> {
    const { sessions } = await this.getComparisonOptions(officeId);
    const index = sessions.findIndex((s) => s.sessionId === fromSessionId);
    if (index === -1) {
      // `fromSessionId` zelf is legacy/niet-vergelijkbaar (kan gebeuren als
      // "Vergelijken" ooit vanuit een oudere sessie bereikbaar wordt) — val
      // terug op de twee nieuwste bruikbare tellingen.
      return { sessionIdB: sessions[0]?.sessionId ?? fromSessionId, sessionIdA: sessions[1]?.sessionId ?? null };
    }
    const previous = sessions[index + 1]; // `sessions` is nieuwste-eerst.
    return { sessionIdB: fromSessionId, sessionIdA: previous?.sessionId ?? null };
  }

  async compareSessions(sessionIdA: string, sessionIdB: string): Promise<SessionComparison> {
    const [sessionA, sessionB] = await Promise.all([
      this.repository.getSession(sessionIdA),
      this.repository.getSession(sessionIdB),
    ]);
    if (!sessionA) throw new ComparisonSessionNotFoundError(sessionIdA);
    if (!sessionB) throw new ComparisonSessionNotFoundError(sessionIdB);
    if (sessionA.officeId !== sessionB.officeId) throw new ComparisonOfficeMismatchError();

    const [finalizedA, finalizedB] = await Promise.all([
      this.repository.getFinalizedSessionResult(sessionIdA),
      this.repository.getFinalizedSessionResult(sessionIdB),
    ]);
    if (!finalizedA) throw new ComparisonNotAvailableError(sessionIdA);
    if (!finalizedB) throw new ComparisonNotAvailableError(sessionIdB);

    const inputA: ComparisonSnapshotInput = {
      sessionId: sessionA.id,
      sessionName: sessionSnapshotName(sessionA),
      sessionType: sessionA.type,
      snapshotDate: finalizedA.snapshot.snapshotDate,
      completedAt: sessionA.completedAt,
      snapshot: finalizedA.snapshot,
    };
    const inputB: ComparisonSnapshotInput = {
      sessionId: sessionB.id,
      sessionName: sessionSnapshotName(sessionB),
      sessionType: sessionB.type,
      snapshotDate: finalizedB.snapshot.snapshotDate,
      completedAt: sessionB.completedAt,
      snapshot: finalizedB.snapshot,
    };

    const history = await this.buildReliableHistoryFromB(sessionB);

    return buildSessionComparison(inputA, inputB, history);
  }

  /**
   * Spec §8: volledige, betrouwbare historiek van het kantoor, nieuwste
   * eerst, gestart bij B zelf — onafhankelijk van welke specifieke A voor de
   * hoofdvergelijking gekozen werd (de opeenvolgende-tellingen-berekening
   * kijkt verder terug dan enkel A). Sessies zonder `FinalizedSessionResult`
   * (legacy) worden WEL meegegeven (zonder `articlesById`) i.p.v. gewoon
   * weggefilterd — enkel zo kan `computeConsecutiveUnchanged` de keten
   * correct laten STOPPEN bij zo'n gat, in plaats van er stilzwijgend
   * overheen te springen (zie de uitleg bij `ReliableHistoryEntry`).
   */
  private async buildReliableHistoryFromB(sessionB: { id: string; officeId: string; completedAt: string | null; startedAt: string }): Promise<ReliableHistoryEntry[]> {
    const allSessions = await this.repository.getSessionsForOffice(sessionB.officeId);
    const bSortKey = sessionB.completedAt ?? sessionB.startedAt;
    const completedSorted = allSessions
      .filter((s) => s.status === "COMPLETED")
      .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt));
    const fromB = completedSorted.filter((s) => (s.completedAt ?? s.startedAt) <= bSortKey);

    const finalizedResults = await Promise.all(fromB.map((s) => this.repository.getFinalizedSessionResult(s.id)));

    return fromB.map((session, index) => {
      const finalized = finalizedResults[index];
      if (!finalized) {
        return { sessionId: session.id, sessionName: sessionSnapshotName(session) };
      }
      return {
        sessionId: session.id,
        sessionName: sessionSnapshotName(session),
        articlesById: new Map(
          finalized.snapshot.articles.map((a) => [a.articleId, { totalCount: a.totalCount, status: a.status }]),
        ),
      };
    });
  }
}
