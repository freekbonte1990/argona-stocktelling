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

/**
 * Belgische datumnotatie, altijd volledig met leidende nullen (bv.
 * "24/09/2026") — visuele-polish-sprint §8. `toLocaleDateString("nl-BE")`
 * geeft standaard GEEN leidende nullen (bv. "24/9/2026"), vandaar deze
 * kleine, expliciete opmaak i.p.v. de kale locale-oproep. Puur weergave: de
 * onderliggende ISO-timestamp/data blijven overal ongewijzigd.
 */
export function formatDate(value: string | Date | null): string {
  if (value === null) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}
