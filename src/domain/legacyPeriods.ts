/**
 * Sprint 3.3 §3: de 7 vereiste historische periodes, exact zoals gespecificeerd.
 * `key` is de stabiele periodesleutel die de adapter aan elke ruwe rij hangt
 * (`LegacyStockRow.periodKey`) — `isoDate`/`label` zijn puur presentatie/
 * `StockHistoryEntry.countDate`.
 */
export interface LegacyPeriod {
  key: string;
  isoDate: string;
  label: string;
}

export const REQUIRED_LEGACY_PERIODS: LegacyPeriod[] = [
  { key: "2025-03-31", isoDate: "2025-03-31", label: "31/03/2025" },
  { key: "2025-06-30", isoDate: "2025-06-30", label: "30/06/2025" },
  { key: "2025-09-30", isoDate: "2025-09-30", label: "30/09/2025" },
  { key: "2025-12-31", isoDate: "2025-12-31", label: "31/12/2025" },
  { key: "2026-03-31", isoDate: "2026-03-31", label: "31/03/2026" },
  { key: "2026-06-30", isoDate: "2026-06-30", label: "30/06/2026" },
  { key: "2026-09-01", isoDate: "2026-09-01", label: "01/09/2026" },
];

export const LEGACY_PERIOD_BY_KEY = new Map(REQUIRED_LEGACY_PERIODS.map((p) => [p.key, p]));

/**
 * Normaliseert de veelvoorkomende brontekst-varianten voor een kwartaal-
 * label ("Q1 2025", "Q12025", "Q1  2025", case-insensitive) naar de
 * bijhorende periodesleutel — `null` wanneer het geen herkenbaar
 * kwartaallabel is (de aanroeper beslist dan zelf, bv. via een expliciete
 * sheetnaam/datum, welke periode van toepassing is).
 */
export function normalizeQuarterLabelToPeriodKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().toUpperCase().match(/^Q\s*([1-4])\s*(\d{4})$/);
  if (!match) return null;
  const quarter = Number(match[1]);
  const year = Number(match[2]);
  const monthEnd: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" };
  return `${year}-${monthEnd[quarter]}`;
}
