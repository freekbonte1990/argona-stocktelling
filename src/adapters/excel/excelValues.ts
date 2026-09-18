/** Waardeconversies voor ruwe Excel-celwaarden (string | number | Date | null | undefined). */

export function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return toIsoDateString(value);
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (text === "") return null;
  // Ondersteun zowel "12.5" als "12,5" (komma als decimaalteken, geen duizendtal-scheiding verwacht
  // aangezien numerieke Excel-cellen als echte getallen binnenkomen; dit pad is een fallback voor
  // tekstueel opgeslagen getallen).
  const normalized = text.includes(",") && !text.includes(".") ? text.replace(",", ".") : text;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toIsoDateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Let op: NIET `.toISOString().slice(0, 10)` gebruiken. De xlsx-library
    // (met `cellDates: true`) bouwt een Date op uit een Excel-datumserieel
    // via de LOKALE tijdzoneconstructor (new Date(jaar, maand, dag)), niet
    // via UTC. In elke tijdzone vóór op UTC (o.a. heel Europa) schuift
    // `.toISOString()` zo'n datum een dag terug (bv. 28-08-2026 wordt
    // "2026-08-27"). Dit werd ontdekt tijdens de v0.1.1-hardeningsprint via
    // de echte Excelbestanden van Antwerpen/Lokeren/Damme: de basisdatum
    // kwam daar telkens één dag te vroeg uit. De lokale getters
    // (getFullYear/getMonth/getDate) geven wél het correcte, door de
    // gebruiker bedoelde datumveld terug.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function isRowBlank(row: unknown[]): boolean {
  return row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
}
