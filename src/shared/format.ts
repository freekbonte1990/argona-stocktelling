/**
 * Kleine, herbruikbare weergaveformattering voor de UI. Puur formattering,
 * geen businesslogica (net als exportFileName.ts) — vandaar hier in
 * `shared/` in plaats van `domain/`.
 */

/** bv. "1 234" voor tellingen — nl-BE-groepering, geen decimalen. */
export function formatCount(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("nl-BE");
}

/** Zelfde als formatCount, maar met een expliciet "+"-teken bij een positieve waarde. */
export function formatSignedCount(value: number | null): string {
  if (value === null) return "—";
  const formatted = Math.abs(value).toLocaleString("nl-BE");
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

/** bv. "€ 12,50" — nl-BE-valutaformattering. */
export function formatEuro(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("nl-BE", { style: "currency", currency: "EUR" });
}

/** Zelfde als formatEuro, maar met een expliciet "+"-teken bij een positief bedrag. */
export function formatSignedEuro(value: number | null): string {
  if (value === null) return "—";
  const formatted = Math.abs(value).toLocaleString("nl-BE", { style: "currency", currency: "EUR" });
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}
