import { computeSessionProgress } from "../../domain/progress";
import type { CountEntry, CountSession, Location, SessionProgress } from "../../domain/types";
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
    const entry: CountEntry = {
      id: `${session.id}:${articleId}:${locationId}`,
      sessionId: session.id,
      articleId,
      locationId,
      quantity,
      counted: true,
      countedAt: new Date().toISOString(),
      note: note ?? null,
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

  async getEntries(sessionId: string): Promise<CountEntry[]> {
    return this.repository.getCountEntries(sessionId);
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
}
