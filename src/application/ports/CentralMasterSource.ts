import type { CentralMasterFile, CentralOfficeSummary } from "../../domain/centralMasterFile";

/**
 * Waarom een centrale bron niet bruikbaar was — de sync vertaalt dit naar een
 * discrete, begrijpelijke melding (nooit een crash, nooit een blokkade van de app).
 * Zelfde soorten als `CentralHistoryError`.
 *
 *  - `not-found`:      er is voor dit kantoor (nog) geen master gepubliceerd.
 *  - `unavailable`:    netwerk/server niet bereikbaar (bv. offline).
 *  - `invalid`:        de bron antwoordde, maar met een onbruikbaar bestand.
 */
export type CentralMasterErrorKind = "not-found" | "unavailable" | "invalid";

export class CentralMasterError extends Error {
  readonly kind: CentralMasterErrorKind;

  constructor(kind: CentralMasterErrorKind, message: string) {
    super(message);
    this.name = "CentralMasterError";
    this.kind = kind;
  }
}

export type CentralMasterFetchResult =
  /** De bron bevestigt dat `knownRevision` nog actueel is — niets te downloaden. */
  | { kind: "unchanged" }
  /** Een (nieuwe) master, al gevalideerd en gegarandeerd van het gevraagde kantoor. */
  | { kind: "master"; file: CentralMasterFile };

export interface FetchOfficeMasterOptions {
  /** De lokaal toegepaste `revision`; de bron mag dan `unchanged` antwoorden (HTTP 304 / eBuddy-ETag). */
  knownRevision?: string | null;
}

/**
 * Centrale, ALLEEN-LEZEN bron voor ACTUELE masterdata (kantoor, locaties,
 * productgamma's, artikelen, koppelingen). Het zusje van `CentralHistorySource`
 * (historiek = autoritatief voor tellingen; master = autoritatief voor stamdata).
 *
 * Er bestaat vanuit de app bewust GEEN schrijf-/publiceermethode.
 *
 * MIGRATIEPAD eBuddy: vandaag `HttpCentralMasterSource` (Vercel-
 * endpoint zonder auth); volgende maand een `EBuddyCentralMasterSource` die dezelfde twee
 * methoden tegen de eBuddy-API implementeert en zijn DTO's naar
 * `CentralMasterFile` vertaalt. Enkel `application/container.ts` verandert.
 * Voorwaarden voor die adapter (identiteitscontract, zie `domain/centralMasterFile.ts`):
 *  1. `articleNumber` blijft de sleutel (`Article.id = officeId:articleNumber`);
 *  2. locatie- en categorie-id's zijn stabiel;
 *  3. `revision` = eBuddy-ETag/`updatedAt`-hash;
 *  4. de per-gebruiker authenticatie van eBuddy komt in de adapter zelf (vandaag is er geen auth).
 */
export interface CentralMasterSource {
  /** Informatief label voor de UI/status. */
  readonly label: string;
  /** Alle centraal beschikbare kantoren (voor het kiezen van een kantoor op een nieuw toestel). */
  fetchOfficeIndex(): Promise<CentralOfficeSummary[]>;
  /** Gooit uitsluitend `CentralMasterError`. */
  fetchOfficeMaster(officeId: string, options?: FetchOfficeMasterOptions): Promise<CentralMasterFetchResult>;
}
