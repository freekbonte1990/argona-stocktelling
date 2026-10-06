import { describe, expect, it } from "vitest";
import { buildLegacyPeriodSnapshot } from "../../domain/stockSnapshot";
import { getStockClassification } from "../../domain/stockClassification";
import { CentralHistorySyncService } from "./CentralHistorySyncService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { FakeCentralHistorySource, makeArticle, makeEntry, makeFile, makeOffice } from "./centralHistoryTestUtils";

const legacy = (articleNumber: string, overrides = {}) =>
  makeEntry({
    articleId: `damme:${articleNumber}`, articleNumber, sessionName: "LEGACY 30/06/2026", countDate: "2026-06-30", sessionType: "FULL",
    status: "LEGACY", source: "LEGACY_IMPORT", sourceSessionId: undefined, previousCount: null, differenceQuantity: null,
    differenceAmount: null, locationNames: [], totalCount: 7, costPrice: 3, ...overrides,
  });

describe("centrale historiek: bevroren classificatie", () => {
  it("vult bij een bestaand toestel ENKEL stockClassification aan op legacy-regels; hoeveelheid/kostprijs blijven onaangeroerd", async () => {
    const repository = new InMemoryCountingRepository();
    await repository.saveOffice(makeOffice());
    await repository.saveArticles([makeArticle("damme", "A1"), makeArticle("damme", "A2")]);
    await repository.saveStockHistoryEntries("damme", [legacy("A1", { totalCount: 7, costPrice: 3 }), legacy("A2")]);
    const source = new FakeCentralHistorySource(
      makeFile([
        legacy("A1", { stockClassification: "OBSOLETE", totalCount: 999, costPrice: 999 }),
        legacy("A2", { stockClassification: "ACTIVE" }),
      ]),
    );
    await new CentralHistorySyncService(repository, source).syncOffice("damme");
    const local = await repository.getStockHistoryEntries("damme");
    const a1 = local.find((e) => e.articleNumber === "A1")!;
    expect(a1).toMatchObject({ stockClassification: "OBSOLETE", totalCount: 7, costPrice: 3 });
    expect(local.find((e) => e.articleNumber === "A2")?.stockClassification).toBe("ACTIVE");
  });

  it("een legacy-snapshot toont de bevroren classificatie, ook als het levende artikel ACTIVE is; onbekend valt terug op het levende artikel", () => {
    const live = new Map([["damme:A1", makeArticle("damme", "A1")], ["damme:A2", makeArticle("damme", "A2")]]);
    const snapshot = buildLegacyPeriodSnapshot("legacy:2026-06-30", "30/06/2026", "2026-06-30", [
      legacy("A1", { stockClassification: "OBSOLETE" }),
      legacy("A2"),
    ], live);
    const byId = new Map(snapshot.articles.map((a) => [a.articleId, a]));
    expect(getStockClassification(byId.get("damme:A1")!.article)).toBe("OBSOLETE");
    expect(getStockClassification(byId.get("damme:A2")!.article)).toBe("ACTIVE");
    expect(live.get("damme:A1")?.stockClassification).not.toBe("OBSOLETE"); // levend artikel blijft ongemoeid
  });

  it("nieuw toestel: de gecorrigeerde centrale sessie heet 2026-Q3 Kwartaal en draagt de bevroren classificatie (snapshot én export)", async () => {
    const repository = new InMemoryCountingRepository();
    await repository.saveOffice(makeOffice());
    await repository.saveArticles([makeArticle("damme", "A1"), makeArticle("damme", "A2")]);
    const q3 = (n: string, c?: "OBSOLETE" | "ACTIVE") =>
      makeEntry({
        articleId: `damme:${n}`, articleNumber: n, sessionName: "2026-Q3 Kwartaal", countDate: "2026-10-06",
        sessionType: "QUARTERLY", sourceSessionId: "central-q3", ...(c ? { stockClassification: c } : {}),
      });
    const source = new FakeCentralHistorySource(makeFile([q3("A1", "OBSOLETE"), q3("A2", "ACTIVE")]));
    await new CentralHistorySyncService(repository, source).syncOffice("damme");
    const finalized = await repository.getFinalizedSessionResult("central-q3");
    expect(finalized?.snapshot.sessionName).toBe("2026-Q3 Kwartaal");
    const a1 = finalized!.snapshot.articles.find((a) => a.articleId === "damme:A1")!;
    expect(getStockClassification(a1.article)).toBe("OBSOLETE");
    expect(a1).toMatchObject({ totalCount: 10, costPrice: 2 });
  });

  it("een toestel dat de sessie al kent onder een andere naam krijgt de hernoemde centrale sessie niet als tweede reeks regels", async () => {
    const repository = new InMemoryCountingRepository();
    await repository.saveOffice(makeOffice());
    await repository.saveArticles([makeArticle("damme", "A1")]);
    const old = makeEntry({ sessionName: "2026-Q4 Kwartaal", countDate: "2026-10-06", sessionType: "QUARTERLY", sourceSessionId: "central-q3" });
    await repository.saveStockHistoryEntries("damme", [old]);
    const renamed = { ...old, sessionName: "2026-Q3 Kwartaal", stockClassification: "OBSOLETE" as const };
    await new CentralHistorySyncService(repository, new FakeCentralHistorySource(makeFile([renamed]))).syncOffice("damme");
    const local = await repository.getStockHistoryEntries("damme");
    expect(local).toHaveLength(1);
    expect(local[0].sessionName).toBe("2026-Q4 Kwartaal"); // lokaal bevroren, ongewijzigd
  });
});
