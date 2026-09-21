import { findHeaderRow, type HeaderLocation } from "./excelHeaderUtils";

export const TELLING_SHEET_NAME = "TELLING";

const TELLING_HEADERS_BEFORE_LOCATIONS = [
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
] as const;

const TELLING_HEADERS_AFTER_LOCATIONS = [
  "Opmerking",
  "AANTAL TOTAAL",
  "Bedrag",
  "Verschil Bedrag",
  "VERSCHIL AANTAL",
  "GETELD?",
] as const;

/** "LOCATIE 1".."LOCATIE N" — v0.2.1: dynamisch aantal, geen vaste 5 meer. */
export function locationColumnHeaders(locationCount: number): string[] {
  return Array.from({ length: locationCount }, (_, i) => `LOCATIE ${i + 1}`);
}

/**
 * Volledige kolomlijst van sheet TELLING voor een kantoor met `locationCount`
 * locaties. Gebruikt zowel bij import (validatie) als bij export (headerrij),
 * zodat beide altijd exact hetzelfde verwachten.
 */
export function buildTellingRequiredHeaders(locationCount: number): string[] {
  return [
    ...TELLING_HEADERS_BEFORE_LOCATIONS,
    ...locationColumnHeaders(locationCount),
    ...TELLING_HEADERS_AFTER_LOCATIONS,
  ];
}

/** Voor bestanden/tests die nog uitgaan van de historische, vaste 5 locaties. */
export const TELLING_REQUIRED_HEADERS = buildTellingRequiredHeaders(5);

/**
 * Valideert dat sheet TELLING aanwezig is en alle verwachte kolommen bevat
 * (gezocht op naam, ongeacht op welke rij de header staat) — inclusief
 * precies `locationCount` LOCATIE-kolommen (v0.2.1 §1: dynamisch aantal).
 *
 * v0.1 gebruikt de rijgegevens van TELLING zelf niet: de app bouwt haar eigen
 * tellingen op in IndexedDB (CountSession/CountEntry) in plaats van deze
 * sheet te lezen of te muteren. We valideren de sheet toch, zodat een
 * verkeerd/onvolledig Excelbestand meteen een duidelijke foutmelding geeft.
 * Zie docs/DATA_MODEL.md voor deze aanname.
 */
export function validateTellingSheet(rows: unknown[][], locationCount: number): HeaderLocation {
  return findHeaderRow(rows, buildTellingRequiredHeaders(locationCount), TELLING_SHEET_NAME);
}
