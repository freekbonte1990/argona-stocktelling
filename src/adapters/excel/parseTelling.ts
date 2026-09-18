import { findHeaderRow, type HeaderLocation } from "./excelHeaderUtils";

export const TELLING_SHEET_NAME = "TELLING";

export const TELLING_REQUIRED_HEADERS = [
  "Artikelnr.",
  "Omschrijving",
  "Productgroep",
  "Leverancier",
  "Artikelstatus",
  "TELPERIODE",
  "Eenheid",
  "Vorige telling",
  "Kostprijs",
  "Waarde vorige telling",
  "LOCATIE 1",
  "LOCATIE 2",
  "LOCATIE 3",
  "LOCATIE 4",
  "LOCATIE 5",
  "Opmerking",
  "AANTAL TOTAAL",
  "Bedrag",
  "Verschil Bedrag",
  "VERSCHIL AANTAL",
  "GETELD?",
] as const;

/**
 * Valideert dat sheet TELLING aanwezig is en alle verwachte kolommen bevat
 * (gezocht op naam, ongeacht op welke rij de header staat).
 *
 * v0.1 gebruikt de rijgegevens van TELLING zelf niet: de app bouwt haar eigen
 * tellingen op in IndexedDB (CountSession/CountEntry) in plaats van deze
 * sheet te lezen of te muteren. We valideren de sheet toch, zodat een
 * verkeerd/onvolledig Excelbestand meteen een duidelijke foutmelding geeft.
 * Zie docs/DATA_MODEL.md voor deze aanname.
 */
export function validateTellingSheet(rows: unknown[][]): HeaderLocation {
  return findHeaderRow(rows, [...TELLING_REQUIRED_HEADERS], TELLING_SHEET_NAME);
}
