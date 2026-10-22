import {
  applySessionCorrections,
  buildCorrectionExport,
  previousCountUpdates,
  SessionCorrectionError,
  type SessionCorrectionExport,
  type SessionCorrectionInput,
  type SessionCorrectionRecord,
} from "../../domain/sessionCorrection";
import type { CountingRepository } from "../ports/CountingRepository";

/** Gegooid wanneer een sessie niet (meer) gecorrigeerd kan worden (niet gevonden / niet afgerond / geen bevroren resultaat). */
export class SessionNotCorrectableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionNotCorrectableError";
  }
}

export interface SessionCorrectionOutcome {
  records: SessionCorrectionRecord[];
  /** `true` als `Article.previousCount` mee bijgewerkt werd (de telling is de laatste afgeronde van het kantoor). */
  previousCountUpdated: boolean;
}

/**
 * Corrigeert het getelde eindaantal per artikel in een AFGERONDE telling.
 * De telling blijft bestaan (zelfde id, naam, datum); enkel de bevroren
 * snapshot/review/HISTORIE-aantallen van de gecorrigeerde artikelen wijzigen,
 * in één transactie. Ook centrale tellingen zijn lokaal corrigeerbaar.
 */
export class SessionCorrectionService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  async correct(
    sessionId: string,
    inputs: readonly SessionCorrectionInput[],
    reason: string | null,
    now: string = new Date().toISOString(),
  ): Promise<SessionCorrectionOutcome> {
    const session = await this.repository.getSession(sessionId);
    if (!session) throw new SessionNotCorrectableError(`Sessie ${sessionId} niet gevonden.`);
    if (session.status !== "COMPLETED") {
      throw new SessionNotCorrectableError("Enkel een afgeronde telling kan gecorrigeerd worden.");
    }
    const current = await this.repository.getFinalizedSessionResult(sessionId);
    if (!current) {
      throw new SessionNotCorrectableError("Deze telling heeft geen bevroren resultaat en kan niet gecorrigeerd worden.");
    }

    const history = await this.repository.getStockHistoryEntries(session.officeId);
    const applied = applySessionCorrections(current, history, inputs, reason?.trim() || null, now);
    if (applied.records.length === 0) return { records: [], previousCountUpdated: false };

    const isLatest = await this.isLatestCompletedSession(session.officeId, sessionId);
    let updatedArticles: Awaited<ReturnType<CountingRepository["getArticles"]>> = [];
    if (isLatest) {
      const articles = await this.repository.getArticles(session.officeId);
      updatedArticles = previousCountUpdates(articles, applied.records);
    }

    await this.repository.applySessionCorrection({
      officeId: session.officeId,
      sessionId,
      sessionName: applied.result.snapshot.sessionName,
      result: applied.result,
      historyEntries: applied.historyEntries,
      updatedArticles,
    });
    return { records: applied.records, previousCountUpdated: isLatest };
  }

  /** Bouwt het exportbestand met de correcties (voor het centraal bijwerken van de historiek). */
  async exportCorrections(
    sessionId: string,
    exportedAt: string = new Date().toISOString(),
  ): Promise<{ fileName: string; content: SessionCorrectionExport }> {
    const session = await this.repository.getSession(sessionId);
    const result = await this.repository.getFinalizedSessionResult(sessionId);
    if (!session || !result) throw new SessionNotCorrectableError("Telling niet gevonden.");
    const content = buildCorrectionExport(session.officeId, result, exportedAt);
    if (content.corrections.length === 0) {
      throw new SessionNotCorrectableError("Deze telling heeft nog geen correcties om te exporteren.");
    }
    const safeName = content.sessionName.replace(/[^A-Za-z0-9_-]+/g, "-");
    return { fileName: `correcties-${session.officeId}-${safeName}.json`, content };
  }

  private async isLatestCompletedSession(officeId: string, sessionId: string): Promise<boolean> {
    const sessions = await this.repository.getSessionsForOffice(officeId);
    const completed = sessions.filter((s) => s.status === "COMPLETED");
    const withResult: { id: string; at: string }[] = [];
    for (const s of completed) {
      if (s.id === sessionId || (await this.repository.getFinalizedSessionResult(s.id))) {
        withResult.push({ id: s.id, at: s.completedAt ?? s.startedAt });
      }
    }
    withResult.sort((a, b) => b.at.localeCompare(a.at));
    return withResult[0]?.id === sessionId;
  }
}

export { SessionCorrectionError };
