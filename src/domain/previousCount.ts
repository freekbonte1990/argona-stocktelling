import type { StockHistoryEntry } from "./stockSnapshot";
import type { Article } from "./types";

/**
 * "Vorige telling" wordt voor een centraal beheerd kantoor UITSLUITEND uit de
 * historiek afgeleid (user-eis D) — nooit uit de centrale master. De
 * historiek is autoritatief voor tellingen.
 *
 * Regel (spiegelt `review.ts#buildNextPreviousCounts`: enkel een effectief
 * geteld/bevestigd resultaat wordt het nieuwe "vorige"): per artikel de
 * `totalCount` van de MEEST RECENTE regel met status GETELD, "0 BEVESTIGD" of
 * LEGACY (een legacy-periode is een echte historische telling). Regels met
 * status OVERGENOMEN ("OVERGENOMEN - NIET GETELD") dragen enkel een waarde over
 * en tellen niet. Meest recent = hoogste `countDate`, bij gelijke datum de
 * hoogste sessienaam.
 */
const COUNTING_STATUSES = new Set(["GETELD", "0 BEVESTIGD", "LEGACY"]);

export function derivePreviousCountsFromHistory(history: readonly StockHistoryEntry[]): Map<string, number> {
  const latest = new Map<string, StockHistoryEntry>();
  for (const entry of history) {
    if (!COUNTING_STATUSES.has(entry.status)) continue;
    if (entry.totalCount === null) continue;
    const current = latest.get(entry.articleId);
    if (
      !current ||
      entry.countDate > current.countDate ||
      (entry.countDate === current.countDate && entry.sessionName.localeCompare(current.sessionName, "nl") > 0)
    ) {
      latest.set(entry.articleId, entry);
    }
  }
  const result = new Map<string, number>();
  for (const [articleId, entry] of latest) result.set(articleId, entry.totalCount as number);
  return result;
}

/**
 * Enkel de artikelen waarvan `previousCount` effectief verandert (nooit een
 * bestaande waarde wissen als de historiek niets voor dat artikel weet).
 */
export function applyDerivedPreviousCounts(articles: readonly Article[], derived: ReadonlyMap<string, number>): Article[] {
  const changed: Article[] = [];
  for (const article of articles) {
    const value = derived.get(article.id);
    if (value === undefined || value === article.previousCount) continue;
    changed.push({ ...article, previousCount: value });
  }
  return changed;
}
