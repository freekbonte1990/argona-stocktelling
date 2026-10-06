import type { CentralHistoryFile } from "../../domain/centralHistoryFile";

/**
 * Waarom een centrale bron niet bruikbaar was — de sync vertaalt dit naar een
 * discrete, begrijpelijke melding (nooit een crash, nooit een blokkade van de
 * app: user-eis 5).
 *
 *  - `not-found`:      er is voor dit kantoor (nog) niets centraal gepubliceerd.
 *  - `unavailable`:    netwerk/server niet bereikbaar (bv. offline).
 *  - `invalid`:        de bron antwoordde, maar met een onbruikbaar bestand.
 */
export type CentralHistoryErrorKind =
  | "not-found"
  | "unavailable"
  | "invalid";

export class CentralHistoryError extends Error {
  readonly kind: CentralHistoryErrorKind;

  constructor(kind: CentralHistoryErrorKind, message: string) {
    super(message);
    this.name = "CentralHistoryError";
    this.kind = kind;
  }
}

/**
 * Centrale, ALLEEN-LEZEN bron voor afgeronde historische stockdata.
 *
 * User-eis 1: vanuit de gewone app bestaat hier bewust GEEN schrijf-/
 * publiceermethode. Publiceren gebeurt buiten de app (script/git/Vercel,
 * zie `scripts/publish-central-history.ts`).
 *
 * User-eis 8 (migratiepad): vandaag `HttpCentralHistorySource` (een
 * Vercel-endpoint zonder authenticatie); later een `EBuddyCentralHistorySource`
 * die dezelfde methode tegen de eBuddy-API implementeert. Enkel `container.ts`
 * verandert — sync-service, repository, Analyse en Vergelijken blijven gelijk.
 */
export interface CentralHistorySource {
  /** Informatief label voor de UI/status (bv. "Argona centrale historiek"). */
  readonly label: string;
  /**
   * Haalt de centrale historiek van één kantoor op. Gooit uitsluitend
   * `CentralHistoryError`. Het resultaat is al gevalideerd (zie
   * `domain/centralHistoryFile.ts#parseCentralHistoryFile`) en hoort gegarandeerd
   * bij `officeId`.
   */
  fetchOfficeHistory(officeId: string): Promise<CentralHistoryFile>;
}
