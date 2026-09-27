import { describe, expect, it } from "vitest";
import { recomputePreviousCountsAfterDeletion } from "./sessionDeletion";
import type { ArticleSnapshot, ArticleSnapshotStatus, StockSnapshot } from "./stockSnapshot";
import type { Article } from "./types";

function makeArticle(overrides: Partial<Article> & Pick<Article, "id" | "officeId" | "articleNumber">): Article {
  return {
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: null,
    supplier: null,
    unit: null,
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: null,
    ...overrides,
  };
}

function makeArticleSnapshot(
  articleId: string,
  status: ArticleSnapshotStatus,
  totalCount: number | null,
  previousCount: number | null,
): ArticleSnapshot {
  return {
    articleId,
    article: makeArticle({ id: articleId, officeId: "office-1", articleNumber: articleId.split(":")[1] ?? articleId }),
    status,
    totalCount,
    previousCount,
    differenceQuantity: null,
    costPrice: 1,
    previousValue: null,
    amount: null,
    differenceAmount: null,
    perLocation: [],
    note: null,
  };
}

function makeSnapshot(sessionId: string, sessionName: string, articles: ArticleSnapshot[]): StockSnapshot {
  return {
    sessionId,
    sessionType: "MONTHLY",
    sessionName,
    snapshotDate: "2026-01-01",
    articles,
  };
}

describe("recomputePreviousCountsAfterDeletion (Sprint 3.3 §5: veilig verwijderen van tellingen)", () => {
  it("verwijderen van de MEEST RECENTE telling valt terug op de laatste overblijvende fysieke telling", () => {
    // A1 werd fysiek geteld op 10 in sessie 1 (oudste, blijft bestaan), dan
    // op 15 in sessie 2 (de sessie die we nu verwijderen). Article.previousCount
    // staat momenteel op 15. Na verwijdering van sessie 2 moet dit terug 10 worden.
    const article = makeArticle({ id: "office-1:A1", officeId: "office-1", articleNumber: "A1", previousCount: 15 });
    const session1Snapshot = makeSnapshot("s1", "2026-01 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 10, 5),
    ]);
    const deletedSnapshot = makeSnapshot("s2", "2026-02 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 15, 10),
    ]);

    const updated = recomputePreviousCountsAfterDeletion(deletedSnapshot, [session1Snapshot], [article]);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("office-1:A1");
    expect(updated[0].previousCount).toBe(10);
  });

  it("verwijderen van een MIDDEN-telling wijzigt niets wanneer een LATERE overblijvende sessie het artikel al herteld heeft", () => {
    // A1: sessie 1 (blijft) telt 10, sessie 2 (wordt verwijderd) telt 15,
    // sessie 3 (blijft, later) telt 20. Article.previousCount staat momenteel
    // op 20 (laatst afgeronde sessie). Sessie 2 verwijderen mag hier NIETS
    // aan veranderen: sessie 3 is nog steeds de laatste echte fysieke telling.
    const article = makeArticle({ id: "office-1:A1", officeId: "office-1", articleNumber: "A1", previousCount: 20 });
    const session1Snapshot = makeSnapshot("s1", "2026-01 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 10, 5),
    ]);
    const session3Snapshot = makeSnapshot("s3", "2026-03 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 20, 15),
    ]);
    const deletedSnapshot = makeSnapshot("s2", "2026-02 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 15, 10),
    ]);

    const updated = recomputePreviousCountsAfterDeletion(
      deletedSnapshot,
      [session1Snapshot, session3Snapshot],
      [article],
    );
    expect(updated).toHaveLength(0);
  });

  it("verwijderen van een MIDDEN-telling herstelt de oudere baseline wanneer GEEN latere overblijvende sessie het artikel hertelde", () => {
    // A1: sessie 1 (blijft) telt 10, sessie 2 (wordt verwijderd) telt 15,
    // sessie 3 (blijft, later) nam het artikel enkel OVER (geen fysieke
    // telling). Article.previousCount staat nu op 15. Na verwijdering van
    // sessie 2 moet dit terug 10 worden (de waarde van vóór sessie 2).
    const article = makeArticle({ id: "office-1:A1", officeId: "office-1", articleNumber: "A1", previousCount: 15 });
    const session1Snapshot = makeSnapshot("s1", "2026-01 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 10, 5),
    ]);
    const session3Snapshot = makeSnapshot("s3", "2026-03 Maand", [
      makeArticleSnapshot("office-1:A1", "OVERGENOMEN", 15, 15),
    ]);
    const deletedSnapshot = makeSnapshot("s2", "2026-02 Maand", [
      makeArticleSnapshot("office-1:A1", "GETELD", 15, 10),
    ]);

    const updated = recomputePreviousCountsAfterDeletion(
      deletedSnapshot,
      [session1Snapshot, session3Snapshot],
      [article],
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].previousCount).toBe(10);
  });

  it("een artikel dat de verwijderde sessie zelf nooit fysiek telde (enkel OVERGENOMEN) blijft volledig ongemoeid", () => {
    const article = makeArticle({ id: "office-1:A2", officeId: "office-1", articleNumber: "A2", previousCount: 7 });
    const deletedSnapshot = makeSnapshot("s2", "2026-02 Maand", [
      makeArticleSnapshot("office-1:A2", "OVERGENOMEN - NIET GETELD", 7, 7),
    ]);

    const updated = recomputePreviousCountsAfterDeletion(deletedSnapshot, [], [article]);
    expect(updated).toHaveLength(0);
  });

  it("0 BEVESTIGD telt ook als een echte fysieke telling (nooit automatisch genegeerd)", () => {
    const article = makeArticle({ id: "office-1:A3", officeId: "office-1", articleNumber: "A3", previousCount: 0 });
    const deletedSnapshot = makeSnapshot("s2", "2026-02 Maand", [
      makeArticleSnapshot("office-1:A3", "0 BEVESTIGD", 0, 4),
    ]);

    const updated = recomputePreviousCountsAfterDeletion(deletedSnapshot, [], [article]);
    expect(updated).toHaveLength(1);
    expect(updated[0].previousCount).toBe(4);
  });
});
