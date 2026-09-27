import {
  buildSessionComparison,
  type ComparisonSnapshotInput,
  type ReliableHistoryEntry,
  type SessionComparison,
} from "../../domain/comparison";
import { LEGACY_PERIOD_BY_SESSION_NAME, legacySessionName } from "../../domain/legacyImport";
import { LEGACY_PERIOD_BY_KEY } from "../../domain/legacyPeriods";
import { buildLegacyPeriodSnapshot, sessionSnapshotName } from "../../domain/stockSnapshot";
import type { CountSessionType } from "../../domain/types";
import type { CountingRepository } from "../ports/CountingRepository";
import type { ProductCategoryService } from "./ProductCategoryService";

/**
 * Sprint 3.3 §1 (legacy Analyse/Vergelijken zonder fake CountSessions):
 * intern, applicatielaag-only ID-schema om een legacy periode als
 * selecteerbaar A/B-vergelijkingspunt te adresseren, zonder ooit een echte
 * `CountSession.id` te verzinnen/aan te maken. Het `"legacy:"`-voorvoegsel
 * botst per constructie nooit met een echte sessie-ID (die dit voorvoegsel
 * nooit gebruikt) — puur een lookup-sleutel voor DEZE service, de domeinlaag
 * kent dit schema niet.
 */
const LEGACY_SESSION_ID_PREFIX = "legacy:";

function encodeLegacySessionId(periodKey: string): string {
  return `${LEGACY_SESSION_ID_PREFIX}${periodKey}`;
}

function decodeLegacyPeriodKey(sessionId: string): string | null {
  return sessionId.startsWith(LEGACY_SESSION_ID_PREFIX)
    ? sessionId.slice(LEGACY_SESSION_ID_PREFIX.length)
    : null;
}

/**
 * Synthetische sorteersleutel voor een legacy periode — vergelijkbaar (via
 * `localeCompare`) met een echte sessie's `completedAt ?? startedAt` (een
 * volledige UTC ISO-timestamp): "middernacht" van de ISO-datum plaatst een
 * legacy-punt bewust VOOR een echte, diezelfde kalenderdag afgeronde sessie
 * (spec: een reeds afgeronde echte telling is "recenter" dan een legacy-
 * momentopname van diezelfde dag).
 */
function legacySortKey(isoDate: string): string {
  return `${isoDate}T00:00:00.000Z`;
}

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
  /** Sprint 3.3 §1 — laat de UI een legacy periode duidelijk labelen ("Historische snapshot"). */
  provenance: "APP_COUNT" | "LEGACY_IMPORT";
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
  private readonly productCategoryService: ProductCategoryService;

  constructor(repository: CountingRepository, productCategoryService: ProductCategoryService) {
    this.repository = repository;
    this.productCategoryService = productCategoryService;
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
        provenance: "APP_COUNT",
      });
    });

    // Sprint 3.3 §1: legacy geïmporteerde periodes zijn ALTIJD ook
    // selecteerbaar als A/B — samengevoegd in dezelfde, chronologisch
    // gesorteerde lijst, nooit als aparte/tweede lijst (spec: "legacy
    // periodes kunnen als A en/of B gekozen worden in Vergelijken").
    options.push(...(await this.getLegacyPeriodOptions(officeId)));
    options.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

    return { sessions: options, hasLegacySessions };
  }

  /**
   * Sprint 3.3 §1: enkel de legacy periodes die voor DIT kantoor ECHT
   * geïmporteerd zijn (minstens één `StockHistoryEntry` met
   * `source: "LEGACY_IMPORT"` voor die periode) — nooit alle 7 mogelijke
   * periodes ongeacht import-status tonen (dat zou een niet-bestaande
   * periode suggereren die gewoon leeg zou uitvallen).
   */
  private async getLegacyPeriodOptions(officeId: string): Promise<ComparisonSessionOption[]> {
    const historyEntries = await this.repository.getStockHistoryEntries(officeId);
    const legacySessionNames = new Set(
      historyEntries.filter((e) => e.source === "LEGACY_IMPORT").map((e) => e.sessionName),
    );
    const options: ComparisonSessionOption[] = [];
    for (const sessionName of legacySessionNames) {
      const period = LEGACY_PERIOD_BY_SESSION_NAME.get(sessionName);
      if (!period) continue; // defensief — zou nooit mogen gebeuren, zie LEGACY_PERIOD_BY_SESSION_NAME.
      options.push({
        sessionId: encodeLegacySessionId(period.key),
        sessionName,
        sessionType: "FULL",
        completedAt: period.isoDate,
        provenance: "LEGACY_IMPORT",
      });
    }
    return options;
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

  /**
   * Sprint 3.3 §1: `sessionIdA`/`sessionIdB` zijn nu ELK ofwel een echte
   * `CountSession.id`, ofwel een gecodeerd legacy-periode-ID
   * (`encodeLegacySessionId`) — vandaar dat `officeId` niet langer uit
   * sessie A afgeleid kan worden (een LEGACY-vs-LEGACY vergelijking heeft
   * geen enkele echte sessie om dat uit te lezen) en nu expliciet moet
   * worden meegegeven door de aanroeper (die het toch al kent, zie
   * `ComparisonPage`).
   */
  async compareSessions(officeId: string, sessionIdA: string, sessionIdB: string): Promise<SessionComparison> {
    const [resolvedA, resolvedB] = await Promise.all([
      this.resolveComparisonInput(officeId, sessionIdA),
      this.resolveComparisonInput(officeId, sessionIdB),
    ]);

    const history = await this.buildReliableHistoryFromB(officeId, resolvedB.sortKey);

    // Sprint 3.2 §12: zelfde resolutieprincipe als AnalysisService — de
    // canonieke Productgamma wordt HIER, uit de HUIDIGE artikelstam,
    // opgebouwd en als expliciete input doorgegeven aan de pure
    // `buildSessionComparison`. Sprint 3.3 §1: geldt letterlijk ook voor een
    // legacy periode — "current canonical Productgamma resolution mag
    // retroactief toegepast worden" was expliciet afgesproken.
    const categoryResolution = await this.productCategoryService.buildCategoryResolution(officeId);

    return buildSessionComparison(resolvedA.input, resolvedB.input, history, categoryResolution);
  }

  /**
   * Lost één A/B-identifier op naar een volwaardige `ComparisonSnapshotInput`
   * — ofwel via het bestaande "echte sessie"-pad (bevroren
   * `FinalizedSessionResult`), ofwel, voor een gecodeerd legacy-periode-ID,
   * via `buildLegacyPeriodSnapshot` (Sprint 3.3 §1) — ZONDER ooit een
   * legacy periode als `CountSession` te behandelen. Geeft ook de
   * sorteersleutel terug die `buildReliableHistoryFromB` nodig heeft om te
   * bepalen welke andere periodes "aan of vóór B" liggen.
   */
  private async resolveComparisonInput(
    officeId: string,
    sessionId: string,
  ): Promise<{ input: ComparisonSnapshotInput; sortKey: string }> {
    const legacyPeriodKey = decodeLegacyPeriodKey(sessionId);
    if (legacyPeriodKey !== null) {
      const period = LEGACY_PERIOD_BY_KEY.get(legacyPeriodKey);
      if (!period) throw new ComparisonSessionNotFoundError(sessionId);

      const historyEntries = await this.repository.getStockHistoryEntries(officeId);
      const sessionName = legacySessionName(period.label);
      const periodEntries = historyEntries.filter(
        (e) => e.source === "LEGACY_IMPORT" && e.sessionName === sessionName,
      );
      if (periodEntries.length === 0) throw new ComparisonNotAvailableError(sessionId);

      const articles = await this.repository.getArticles(officeId);
      const articlesById = new Map(articles.map((a) => [a.id, a]));
      const snapshot = buildLegacyPeriodSnapshot(sessionId, period.label, period.isoDate, periodEntries, articlesById);

      return {
        input: {
          sessionId,
          sessionName,
          sessionType: "FULL",
          snapshotDate: period.isoDate,
          completedAt: period.isoDate,
          snapshot,
          provenance: "LEGACY_IMPORT",
        },
        sortKey: legacySortKey(period.isoDate),
      };
    }

    const session = await this.repository.getSession(sessionId);
    if (!session) throw new ComparisonSessionNotFoundError(sessionId);
    if (session.officeId !== officeId) throw new ComparisonOfficeMismatchError();

    const finalized = await this.repository.getFinalizedSessionResult(sessionId);
    if (!finalized) throw new ComparisonNotAvailableError(sessionId);

    return {
      input: {
        sessionId: session.id,
        sessionName: sessionSnapshotName(session),
        sessionType: session.type,
        snapshotDate: finalized.snapshot.snapshotDate,
        completedAt: session.completedAt,
        snapshot: finalized.snapshot,
        provenance: "APP_COUNT",
      },
      sortKey: session.completedAt ?? session.startedAt,
    };
  }

  /**
   * Spec §8: volledige, betrouwbare historiek van het kantoor, nieuwste
   * eerst, gestart bij B zelf — onafhankelijk van welke specifieke A voor de
   * hoofdvergelijking gekozen werd (de opeenvolgende-tellingen-berekening
   * kijkt verder terug dan enkel A). Sessies zonder `FinalizedSessionResult`
   * (legacy/pre-hardening) worden WEL meegegeven (zonder `articlesById`)
   * i.p.v. gewoon weggefilterd — enkel zo kan `computeConsecutiveUnchanged`
   * de keten correct laten STOPPEN bij zo'n gat, in plaats van er
   * stilzwijgend overheen te springen (zie de uitleg bij `ReliableHistoryEntry`).
   *
   * Sprint 3.3 §1: legacy GEÏMPORTEERDE periodes tellen nu OOK mee in deze
   * keten (spec: "Consecutive unchanged / obsolete candidate logic mag
   * legacy alleen meenemen wanneer quantity voor het betreffende artikel
   * betrouwbaar bekend is") — `computeConsecutiveUnchanged` dwingt dat zelf
   * al af (stopt hard op een `null totalCount`), hier wordt enkel de
   * waarheidsgetrouwe data doorgegeven, nooit iets verzonnen.
   */
  private async buildReliableHistoryFromB(officeId: string, bSortKey: string): Promise<ReliableHistoryEntry[]> {
    const [allSessions, historyEntries] = await Promise.all([
      this.repository.getSessionsForOffice(officeId),
      this.repository.getStockHistoryEntries(officeId),
    ]);

    const completed = allSessions.filter((s) => s.status === "COMPLETED");
    const finalizedResults = await Promise.all(completed.map((s) => this.repository.getFinalizedSessionResult(s.id)));

    const candidates: Array<{ sortKey: string; entry: ReliableHistoryEntry }> = completed.map((session, index) => {
      const sortKey = session.completedAt ?? session.startedAt;
      const finalized = finalizedResults[index];
      if (!finalized) {
        return { sortKey, entry: { sessionId: session.id, sessionName: sessionSnapshotName(session) } };
      }
      return {
        sortKey,
        entry: {
          sessionId: session.id,
          sessionName: sessionSnapshotName(session),
          articlesById: new Map(
            finalized.snapshot.articles.map((a) => [a.articleId, { totalCount: a.totalCount, status: a.status }]),
          ),
        },
      };
    });

    const legacyEntriesBySessionName = new Map<string, typeof historyEntries>();
    for (const entry of historyEntries) {
      if (entry.source !== "LEGACY_IMPORT") continue;
      const list = legacyEntriesBySessionName.get(entry.sessionName) ?? [];
      list.push(entry);
      legacyEntriesBySessionName.set(entry.sessionName, list);
    }
    for (const [sessionName, entries] of legacyEntriesBySessionName) {
      const period = LEGACY_PERIOD_BY_SESSION_NAME.get(sessionName);
      if (!period) continue; // defensief — zou nooit mogen gebeuren.
      candidates.push({
        sortKey: legacySortKey(period.isoDate),
        entry: {
          sessionId: encodeLegacySessionId(period.key),
          sessionName,
          articlesById: new Map(entries.map((e) => [e.articleId, { totalCount: e.totalCount, status: e.status }])),
        },
      });
    }

    return candidates
      .filter((c) => c.sortKey <= bSortKey)
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
      .map((c) => c.entry);
  }
}
