import type { CountSession } from "../domain/types";

/**
 * Data-integriteit-sprint §1: gegooid door elke sessie-gebonden schrijfactie
 * (`CountingService#recordCount`/`confirmAbsent`/`confirmAllAbsent`/
 * `completeLocation`/`reopenLocation`, `NewArticleService#createArticleFoundDuringCounting`)
 * zodra de betrokken sessie niet (meer) ACTIVE is. Een COMPLETED sessie is
 * een onveranderlijke, historische snapshot ("Historische telling =
 * read-only snapshot") en een CANCELLED sessie is definitief afgesloten —
 * geen enkele service-laag-actie mag daar nog iets aan wijzigen, ongeacht wat
 * de UI toelaat. Dit is bewust een SERVICE-laag-controle (niet enkel een
 * UI-vlag die knoppen verbergt): zelfs een verouderd/geopend tabblad, een
 * directe API-aanroep, of een toekomstige eBuddy-integratie kan hier nooit
 * omheen.
 */
export class SessionNotEditableError extends Error {
  readonly sessionId: string;
  readonly status: string;

  constructor(sessionId: string, status: string) {
    super(
      `Sessie ${sessionId} heeft status ${status} — een COMPLETED of CANCELLED telling is een ` +
        "onveranderlijke, historische snapshot en kan niet meer bewerkt worden.",
    );
    this.name = "SessionNotEditableError";
    this.sessionId = sessionId;
    this.status = status;
  }
}

/** Gooit `SessionNotEditableError` tenzij de sessie (nog) ACTIVE is. Zie `SessionNotEditableError` hierboven. */
export function assertSessionEditable(session: Pick<CountSession, "id" | "status">): void {
  if (session.status !== "ACTIVE") {
    throw new SessionNotEditableError(session.id, session.status);
  }
}
