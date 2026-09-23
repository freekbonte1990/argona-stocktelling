import { computeSessionProgress } from "../../domain/progress";
import { assertValidQuantity } from "../../domain/quantityValidation";
import type {
  CountEntry,
  CountSession,
  Location,
  LocationSessionStatus,
  SessionProgress,
} from "../../domain/types";
import { assertSessionEditable } from "../errors";
import type { CountingRepository } from "../ports/CountingRepository";

export interface RecordCountInput {
  session: CountSession;
  articleId: string;
  locationId: string;
  quantity: number;
  note?: string | null;
}

/**
 * Alles wat met het effectief tellen te maken heeft: een telling opslaan
 * (en meteen de locatie "leren"), en voortgang opvragen.
 */
export class CountingService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  /**
   * Slaat één telling op (quantity + counted=true) en zorgt dat deze
   * locatie voortaan als "verwacht" geldt voor dit artikel (spec §9).
   *
   * BELANGRIJK: quantity=0 is een volwaardige, geldige telling. We zetten
   * hier altijd counted=true — er bestaat geen pad dat enkel op quantity
   * steunt om te bepalen of iets geteld is.
   */
  async recordCount(input: RecordCountInput): Promise<CountEntry> {
    const { session, articleId, locationId, quantity, note } = input;
    // Data-integriteit-sprint §1/§6: BEIDE controles gebeuren hier, aan de
    // service-laag, vóór er iets geschreven wordt — nooit enkel op de UI
    // vertrouwen (zie `SessionNotEditableError`/`InvalidQuantityError`).
    assertSessionEditable(session);
    assertValidQuantity(quantity);
    const entry: CountEntry = {
      id: `${session.id}:${articleId}:${locationId}`,
      sessionId: session.id,
      articleId,
      locationId,
      quantity,
      counted: true,
      countedAt: new Date().toISOString(),
      note: note ?? null,
      resolution: "COUNTED",
    };
    await this.repository.saveCountEntry(entry);
    await this.repository.saveArticleLocationAssignment({
      id: `${session.officeId}:${articleId}:${locationId}`,
      officeId: session.officeId,
      articleId,
      locationId,
      active: true,
      lastSeenAt: entry.countedAt as string,
    });
    return entry;
  }

  /**
   * Spec v0.2.1 §5: expliciet bevestigen dat een artikel nergens werd
   * aangetroffen (voorraad 0). Dit is een geldige telling — NOOIT hetzelfde
   * als "niet geteld" — maar heeft bewust GEEN locatie: er wordt geen
   * fictieve fysieke locatie verzonnen. Leert dus ook geen
   * ArticleLocationAssignment.
   */
  async confirmAbsent(session: CountSession, articleId: string): Promise<CountEntry> {
    assertSessionEditable(session);
    const entry: CountEntry = {
      id: `${session.id}:${articleId}:absent`,
      sessionId: session.id,
      articleId,
      locationId: null,
      quantity: 0,
      counted: true,
      countedAt: new Date().toISOString(),
      note: null,
      resolution: "CONFIRMED_ABSENT",
    };
    await this.repository.saveCountEntry(entry);
    return entry;
  }

  /** Bulkversie van confirmAbsent — enkel voor gebruik ná een duidelijke bevestiging in de UI (spec §5). */
  async confirmAllAbsent(session: CountSession, articleIds: string[]): Promise<CountEntry[]> {
    const entries: CountEntry[] = [];
    for (const articleId of articleIds) {
      entries.push(await this.confirmAbsent(session, articleId));
    }
    return entries;
  }

  async getEntries(sessionId: string): Promise<CountEntry[]> {
    return this.repository.getCountEntries(sessionId);
  }

  /** Status per (sessie, locatie) — spec §4. */
  async getLocationStatuses(sessionId: string): Promise<LocationSessionStatus[]> {
    return this.repository.getLocationSessionStatuses(sessionId);
  }

  /** Markeert een locatie als afgerond binnen deze sessie. Kan later altijd heropend worden. */
  async completeLocation(sessionId: string, locationId: string): Promise<void> {
    await this.assertEditableSession(sessionId);
    await this.repository.saveLocationSessionStatus({
      id: `${sessionId}:${locationId}`,
      sessionId,
      locationId,
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
    });
  }

  /** Heropent een eerder afgeronde locatie binnen deze sessie (spec §4: "moet later opnieuw geopend kunnen worden"). */
  async reopenLocation(sessionId: string, locationId: string): Promise<void> {
    await this.assertEditableSession(sessionId);
    await this.repository.saveLocationSessionStatus({
      id: `${sessionId}:${locationId}`,
      sessionId,
      locationId,
      status: "OPEN",
      completedAt: null,
    });
  }

  async getProgress(session: CountSession, locations: Location[]): Promise<SessionProgress> {
    const entries = await this.repository.getCountEntries(session.id);
    return computeSessionProgress(session.articleIds, locations, entries);
  }

  /** Artikel-IDs die op deze locatie verwacht worden (voor sortering + "op deze locatie verwacht"-lijst). */
  async getExpectedArticleIds(officeId: string, locationId: string): Promise<Set<string>> {
    const assignments = await this.repository.getArticleLocationAssignments(officeId);
    return new Set(
      assignments
        .filter((assignment) => assignment.active && assignment.locationId === locationId)
        .map((assignment) => assignment.articleId),
    );
  }

  /**
   * `completeLocation`/`reopenLocation` krijgen enkel een `sessionId` mee
   * (niet de volledige sessie zoals `recordCount`/`confirmAbsent`) — dit
   * haalt de sessie vers op en gooit `SessionNotEditableError` zodra ze niet
   * (meer) ACTIVE is, exact dezelfde regel als de rest van deze klasse.
   */
  private async assertEditableSession(sessionId: string): Promise<void> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    assertSessionEditable(session);
  }
}
