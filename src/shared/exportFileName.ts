/**
 * Bestandsnaam voor een geëxporteerd resultatenbestand (spec v0.2 §6), bv.
 * "2026-09-30 - Stocktelling Lokeren.xlsx". Puur formattering, geen
 * businesslogica — vandaar hier in `shared/` in plaats van `domain/`.
 */
export function buildExportFileName(officeName: string, date: Date): string {
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  return `${iso} - Stocktelling ${officeName}.xlsx`;
}
