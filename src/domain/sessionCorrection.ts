import type { ArticleReviewResult, SessionReviewSummary } from "./review";
import type { StockHistoryEntry, StockSnapshot } from "./stockSnapshot";
import type { Article } from "./types";

/**
 * Correctie van een AFGERONDE telling (alleen het getelde eindaantal per artikel).
 *
 * De telling zelf blijft bestaan: zelfde `sessionId`, naam en datum. Kostprijs,
 * artikelnaam en alle andere tellingen blijven bevroren. Elke correctie wordt
 * bewaard als `SessionCorrectionRecord` (auditspoor, exporteerbaar).
 */
export interface SessionCorrectionRecord {
  articleId: string;
  articleNumber: string;
  description: string;
  oldTotalCount: number | null;
  newTotalCount: number;
  reason: string | null;
  correctedAt: string;
}

export interface SessionCorrectionInput {
  articleId: string;
  newTotalCount: number;
}

export class SessionCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCorrectionError";
  }
}

export interface FrozenSessionResult {
  sessionId: string;
  review: SessionReviewSummary;
  snapshot: StockSnapshot;
  corrections?: SessionCorrectionRecord[];
}

export interface AppliedSessionCorrection<T extends FrozenSessionResult> {
  result: T;
  /** Enkel de gewijzigde HISTORIE-regels (zelfde sleutel: sessienaam + artikel). */
  historyEntries: StockHistoryEntry[];
  /** Enkel de effectief gewijzigde artikelen (oud !== nieuw). */
  records: SessionCorrectionRecord[];
}

/** Statussen die gecorrigeerd mogen worden; een overgenomen (niet geteld) artikel wordt door de correctie "geteld". */
export function isCorrectableStatus(status: string): boolean {
  return status === "GETELD" || status === "0 BEVESTIGD" || status === "OVERGENOMEN" || status === "OVERGENOMEN - NIET GETELD";
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Pure berekening: past de correcties toe op het bevroren resultaat en geeft het
 * nieuwe resultaat + de bijhorende HISTORIE-regels terug. Gooit een
 * `SessionCorrectionError` bij een ongeldig aantal of een artikel dat in deze
 * telling niet (fysiek) geteld is. Een correctie naar hetzelfde aantal is een no-op.
 */
export function applySessionCorrections<T extends FrozenSessionResult>(
  current: T,
  existingHistory: readonly StockHistoryEntry[],
  inputs: readonly SessionCorrectionInput[],
  reason: string | null,
  now: string,
): AppliedSessionCorrection<T> {
  const inputByArticle = new Map<string, number>();
  for (const input of inputs) {
    if (!Number.isFinite(input.newTotalCount) || input.newTotalCount < 0) {
      throw new SessionCorrectionError("Een aantal moet een getal van 0 of meer zijn.");
    }
    inputByArticle.set(input.articleId, input.newTotalCount);
  }

  const snapshotArticles = new Map(current.snapshot.articles.map((a) => [a.articleId, a]));
  for (const articleId of inputByArticle.keys()) {
    const found = snapshotArticles.get(articleId);
    if (!found) throw new SessionCorrectionError(`Artikel ${articleId} komt niet voor in deze telling.`);
    if (!isCorrectableStatus(found.status)) {
      throw new SessionCorrectionError(
        `Artikel ${found.article.articleNumber} komt uit een historische import en kan niet gecorrigeerd worden.`,
      );
    }
  }

  const records: SessionCorrectionRecord[] = [];
  const changedIds = new Set<string>();
  const correctedByArticle = new Map<string, { total: number; diffQty: number | null; amount: number | null; diffAmount: number | null; status: "GETELD" | "0 BEVESTIGD"; note: string }>();

  const articles = current.snapshot.articles.map((snap) => {
    const next = inputByArticle.get(snap.articleId);
    if (next === undefined || next === snap.totalCount) return snap;
    const costPrice = snap.costPrice;
    const carried = snap.status === "OVERGENOMEN" || snap.status === "OVERGENOMEN - NIET GETELD";
    const diffQty = carried || snap.differenceQuantity !== null ? round(next - (snap.previousCount ?? 0)) : null;
    const amount = costPrice !== null ? round(next * costPrice) : null;
    const diffAmount = diffQty !== null && costPrice !== null ? round(diffQty * costPrice) : null;
    const status: "GETELD" | "0 BEVESTIGD" = snap.status === "0 BEVESTIGD" && next === 0 ? "0 BEVESTIGD" : "GETELD";
    const marker = carried
      ? `Gecorrigeerd: niet geteld (overgenomen ${snap.totalCount ?? "—"}), nu geteld ${next}`
      : `Gecorrigeerd van ${snap.totalCount ?? "—"} naar ${next}`;
    const note = snap.note ? `${snap.note} · ${marker}` : marker;
    records.push({
      articleId: snap.articleId,
      articleNumber: snap.article.articleNumber,
      description: snap.article.description,
      oldTotalCount: snap.totalCount,
      newTotalCount: next,
      reason,
      correctedAt: now,
    });
    changedIds.add(snap.articleId);
    correctedByArticle.set(snap.articleId, { total: next, diffQty, amount, diffAmount, status, note });
    return { ...snap, totalCount: next, differenceQuantity: diffQty, amount, differenceAmount: diffAmount, status, note };
  });

  if (records.length === 0) {
    return { result: current, historyEntries: [], records };
  }

  // Review: zelfde artikelen bijwerken en de samenvattende totalen opnieuw sommeren.
  const results = current.review.results.map((r): ArticleReviewResult => {
    const c = correctedByArticle.get(r.articleId);
    if (!c) return r;
    return {
      ...r,
      fullyCounted: true,
      newTotalCount: c.total,
      differenceQuantity: c.diffQty,
      amount: c.amount,
      differenceAmount: c.diffAmount,
      confirmedAbsent: c.status === "0 BEVESTIGD",
      note: c.note,
    };
  });
  let countedArticles = 0;
  let articlesWithDifference = 0;
  let posQty = 0;
  let negQty = 0;
  let posAmt = 0;
  let negAmt = 0;
  for (const r of results) {
    if (r.isManualAddition) continue;
    if (r.fullyCounted) countedArticles += 1;
    if (r.differenceQuantity !== null && r.differenceQuantity !== 0) {
      articlesWithDifference += 1;
      if (r.differenceQuantity > 0) posQty += r.differenceQuantity;
      else negQty += r.differenceQuantity;
    }
    if (r.differenceAmount !== null && r.differenceAmount !== 0) {
      if (r.differenceAmount > 0) posAmt += r.differenceAmount;
      else negAmt += r.differenceAmount;
    }
  }
  const review: SessionReviewSummary = {
    ...current.review,
    results,
    countedArticles,
    notCountedArticles: current.review.totalArticlesInScope - countedArticles,
    articlesWithDifference,
    totalPositiveCorrectionQuantity: round(posQty),
    totalNegativeCorrectionQuantity: round(negQty),
    totalPositiveCorrectionAmount: round(posAmt),
    totalNegativeCorrectionAmount: round(negAmt),
  };

  const result = {
    ...current,
    review,
    snapshot: { ...current.snapshot, articles },
    corrections: [...(current.corrections ?? []), ...records],
  } as T;

  const historyEntries: StockHistoryEntry[] = [];
  for (const entry of existingHistory) {
    if (entry.sessionName !== current.snapshot.sessionName) continue;
    const c = correctedByArticle.get(entry.articleId);
    if (!c) continue;
    historyEntries.push({
      ...entry,
      totalCount: c.total,
      differenceQuantity: c.diffQty,
      differenceAmount: c.diffAmount,
      status: c.status,
    });
  }
  return { result, historyEntries, records };
}

/** Het exportbestand met de correcties van één telling (voor de centrale historiek). */
export interface SessionCorrectionExport {
  kind: "argona-session-corrections";
  version: 1;
  officeId: string;
  sessionId: string;
  sessionName: string;
  countDate: string;
  exportedAt: string;
  corrections: SessionCorrectionRecord[];
}

export function buildCorrectionExport(
  officeId: string,
  result: FrozenSessionResult,
  exportedAt: string,
): SessionCorrectionExport {
  // Laatste correctie per artikel wint (oldTotalCount van de EERSTE blijft het origineel).
  const byArticle = new Map<string, SessionCorrectionRecord>();
  for (const record of result.corrections ?? []) {
    const first = byArticle.get(record.articleId);
    byArticle.set(record.articleId, first ? { ...record, oldTotalCount: first.oldTotalCount } : record);
  }
  return {
    kind: "argona-session-corrections",
    version: 1,
    officeId,
    sessionId: result.sessionId,
    sessionName: result.snapshot.sessionName,
    countDate: result.snapshot.snapshotDate,
    exportedAt,
    corrections: Array.from(byArticle.values()),
  };
}

/** Nieuwe `Article.previousCount` voor gecorrigeerde artikelen (basis voor de volgende telling). */
export function previousCountUpdates(articles: readonly Article[], records: readonly SessionCorrectionRecord[]): Article[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const out: Article[] = [];
  for (const record of records) {
    const article = byId.get(record.articleId);
    if (article && article.previousCount !== record.newTotalCount) {
      out.push({ ...article, previousCount: record.newTotalCount });
    }
  }
  return out;
}
