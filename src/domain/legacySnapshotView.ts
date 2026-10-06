import { LEGACY_PERIOD_BY_SESSION_NAME } from "./legacyImport";
import type { ArticleCategoryResolution } from "./productCategory";
import type { StockHistoryEntry, StockSnapshot } from "./stockSnapshot";

/**
 * "Historische snapshots" (legacy periodes) als item onder Home → "Vorige
 * tellingen". Een legacy periode is NOOIT een `CountSession` (zie
 * `buildLegacyPeriodSnapshot`): dit is puur een presentatie-item, afgeleid uit
 * de reeds aanwezige `StockHistoryEntry`-regels met `source: "LEGACY_IMPORT"`.
 */
export const LEGACY_SNAPSHOT_ID_PREFIX = "legacy:";

export function encodeLegacySnapshotId(periodKey: string): string {
  return `${LEGACY_SNAPSHOT_ID_PREFIX}${periodKey}`;
}

export function decodeLegacySnapshotId(id: string): string | null {
  return id.startsWith(LEGACY_SNAPSHOT_ID_PREFIX) ? id.slice(LEGACY_SNAPSHOT_ID_PREFIX.length) : null;
}

export function isLegacySnapshotId(id: string): boolean {
  return decodeLegacySnapshotId(id) !== null;
}

/** Sorteersleutel, vergelijkbaar met `CountSession.startedAt`/`completedAt` (UTC ISO-timestamp). */
export function legacySnapshotSortKey(isoDate: string): string {
  return `${isoDate}T00:00:00.000Z`;
}

export interface LegacySnapshotListItem {
  /** `legacy:<periodKey>` — ook het A/B-id in Vergelijken. */
  id: string;
  periodKey: string;
  /** Leesbaar label, bv. "01/09/2026". */
  periodLabel: string;
  isoDate: string;
  sessionName: string;
  articleCount: number;
  sortKey: string;
}

/** Eén item per (herkende) legacy periode die voor dit kantoor effectief regels heeft. Nieuwste eerst. */
export function listLegacySnapshotItems(entries: readonly StockHistoryEntry[]): LegacySnapshotListItem[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.source !== "LEGACY_IMPORT") continue;
    counts.set(entry.sessionName, (counts.get(entry.sessionName) ?? 0) + 1);
  }
  const items: LegacySnapshotListItem[] = [];
  for (const [sessionName, articleCount] of counts) {
    const period = LEGACY_PERIOD_BY_SESSION_NAME.get(sessionName);
    if (!period) continue;
    items.push({
      id: encodeLegacySnapshotId(period.key),
      periodKey: period.key,
      periodLabel: period.label,
      isoDate: period.isoDate,
      sessionName,
      articleCount,
      sortKey: legacySnapshotSortKey(period.isoDate),
    });
  }
  return items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}

/** Titel zoals getoond op Home en in het detailscherm. */
export function legacySnapshotTitle(periodLabel: string): string {
  return `${periodLabel} — Historische snapshot`;
}

export interface LegacySnapshotArticleRow {
  articleId: string;
  articleNumber: string;
  description: string;
  productCategory: string;
  /** Originele historische hoeveelheid (null = onbekend). */
  quantity: number | null;
  /** Originele historische kostprijs (null = onbekend) — NOOIT de actuele kostprijs. */
  costPrice: number | null;
  /** quantity × historische kostprijs (null als één van beide onbekend). */
  value: number | null;
}

export interface LegacySnapshotCategoryRow {
  categoryName: string;
  articleCount: number;
  stockValue: number;
}

export interface LegacySnapshotView {
  periodLabel: string;
  isoDate: string;
  officeId: string;
  totalStockValue: number;
  articleCount: number;
  articlesWithUnknownValue: number;
  categories: LegacySnapshotCategoryRow[];
  articles: LegacySnapshotArticleRow[];
}

/**
 * Pure projectie van de bevroren legacy-`StockSnapshot` (uit
 * `buildLegacyPeriodSnapshot`) naar het detail-/exportmodel. Leest
 * UITSLUITEND `ArticleSnapshot.totalCount`/`.costPrice` (de historische
 * brondata van de periode) — `ArticleSnapshot.article.costPrice` (de LEVENDE
 * kostprijs) wordt hier bewust nergens gelezen. Alleen het Productgamma komt,
 * zoals in Analyse/Vergelijken, uit de huidige canonieke resolutie.
 */
export function buildLegacySnapshotView(
  officeId: string,
  periodLabel: string,
  snapshot: StockSnapshot,
  categoryResolution: ReadonlyMap<string, ArticleCategoryResolution>,
): LegacySnapshotView {
  const articles: LegacySnapshotArticleRow[] = snapshot.articles.map((row) => {
    const quantity = row.totalCount;
    const costPrice = row.costPrice;
    return {
      articleId: row.articleId,
      articleNumber: row.article.articleNumber,
      description: row.article.description,
      productCategory: categoryResolution.get(row.articleId)?.categoryName ?? "Zonder productgamma",
      quantity,
      costPrice,
      value: quantity !== null && costPrice !== null ? quantity * costPrice : null,
    };
  });
  articles.sort(
    (a, b) =>
      a.productCategory.localeCompare(b.productCategory, "nl") ||
      a.description.localeCompare(b.description, "nl") ||
      a.articleNumber.localeCompare(b.articleNumber, "nl"),
  );

  const byCategory = new Map<string, LegacySnapshotCategoryRow>();
  let totalStockValue = 0;
  let unknown = 0;
  for (const row of articles) {
    const category = byCategory.get(row.productCategory) ?? {
      categoryName: row.productCategory,
      articleCount: 0,
      stockValue: 0,
    };
    category.articleCount += 1;
    if (row.value === null) unknown += 1;
    else {
      category.stockValue += row.value;
      totalStockValue += row.value;
    }
    byCategory.set(row.productCategory, category);
  }

  return {
    periodLabel,
    isoDate: snapshot.snapshotDate,
    officeId,
    totalStockValue,
    articleCount: articles.length,
    articlesWithUnknownValue: unknown,
    categories: Array.from(byCategory.values()).sort((a, b) => b.stockValue - a.stockValue),
    articles,
  };
}

export type PreviousCountItem =
  | { kind: "SESSION"; id: string; sortKey: string; session: import("./types").CountSession }
  | { kind: "LEGACY"; id: string; sortKey: string; legacy: LegacySnapshotListItem };

/**
 * Home → "Vorige tellingen": één chronologische lijst (nieuwste eerst) van
 * echte afgeronde app-tellingen én legacy historische snapshots. Echte
 * sessies sorteren op `startedAt` (ongewijzigd t.o.v. voorheen); bij dezelfde
 * dag staat de echte telling boven de legacy snapshot (zelfde conventie als
 * `ComparisonService`: een echte telling is "recenter" dan een legacy-punt).
 */
export function buildPreviousCountList(
  completedSessions: readonly import("./types").CountSession[],
  legacyItems: readonly LegacySnapshotListItem[],
): PreviousCountItem[] {
  const items: PreviousCountItem[] = [
    ...completedSessions.map((session): PreviousCountItem => ({
      kind: "SESSION",
      id: session.id,
      sortKey: session.startedAt,
      session,
    })),
    ...legacyItems.map((legacy): PreviousCountItem => ({ kind: "LEGACY", id: legacy.id, sortKey: legacy.sortKey, legacy })),
  ];
  return items.sort(
    (a, b) => b.sortKey.localeCompare(a.sortKey) || (a.kind === b.kind ? 0 : a.kind === "SESSION" ? -1 : 1),
  );
}
