import { beforeEach, describe, expect, it } from "vitest";
import { AnalysisService, SessionNotAnalyzableError, SessionNotFoundError } from "./AnalysisService";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import type { Article, Office } from "../../domain/types";

/**
 * Sprint 2 (Historical Count Analysis) §13/§17: `AnalysisService` mag NOOIT
 * afhangen van intussen gewijzigde levende artikeldata voor een reeds
 * afgeronde sessie — dit test-bestand bewijst dat met de ECHTE services
 * (`CountSessionService`/`CountingService`), nooit met handgeschreven
 * `ArticleSnapshot`-fixtures, exact hetzelfde patroon als
 * `dataIntegrityHardening.integration.test.ts`.
 */

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "A1",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: "Oude productgroep",
    supplier: null,
    unit: "stuk",
    costPrice: 10,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
    ...overrides,
  };
}

const office: Office = {
  id: "office-1",
  name: "Lokeren",
  baseDate: "2026-09-01",
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
};

describe("AnalysisService", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;
  let analysisService: AnalysisService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    analysisService = new AnalysisService(repository);
    await repository.saveOffice(office);
    await repository.saveArticles([
      makeArticle({ articleNumber: "A1", costPrice: 10, productGroup: "Oude productgroep" }),
    ]);
  });

  it("gooit SessionNotFoundError voor een onbestaande sessie", async () => {
    await expect(analysisService.getSessionAnalysis("does-not-exist")).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("gooit SessionNotAnalyzableError voor een nog LOPENDE (ACTIVE) sessie", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await expect(analysisService.getSessionAnalysis(session.id)).rejects.toBeInstanceOf(
      SessionNotAnalyzableError,
    );
  });

  it("gooit SessionNotAnalyzableError voor een GEANNULEERDE sessie", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await sessionService.cancelSession(session.id);
    await expect(analysisService.getSessionAnalysis(session.id)).rejects.toBeInstanceOf(
      SessionNotAnalyzableError,
    );
  });

  it("een latere kostprijs-/productgroep-/classificatiewijziging op het levende artikel raakt een reeds afgeronde analyse nooit (spec §13, kernvereiste van Sprint 2)", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await countingService.completeLocation(session.id, "office-1:loc-1");
    await sessionService.completeSession(session.id);

    const analysisBefore = await analysisService.getSessionAnalysis(session.id);
    expect(analysisBefore.kpis.totalStockValue).toBe(80); // 8 * €10
    expect(analysisBefore.productGroups[0].productGroup).toBe("Oude productgroep");
    expect(analysisBefore.obsolete.obsoleteArticleCount).toBe(0);

    // Exact het scenario dat spec §13 verbiedt: een kostprijscorrectie,
    // productgroepwijziging én OBSOLETE-classificatie op het ArticleDetail-
    // scherm, NA het afronden van de sessie — via de echte, immutabele
    // opslagpatroon (`saveArticles` met een spread-kopie, nooit een mutatie).
    const [liveArticle] = await repository.getArticles("office-1");
    await repository.saveArticles([
      {
        ...liveArticle,
        costPrice: 999,
        productGroup: "Nieuwe productgroep",
        stockClassification: "OBSOLETE",
      },
    ]);

    const analysisAfter = await analysisService.getSessionAnalysis(session.id);
    expect(analysisAfter).toEqual(analysisBefore);
    expect(analysisAfter.kpis.totalStockValue).toBe(80);
    expect(analysisAfter.productGroups[0].productGroup).toBe("Oude productgroep");
    expect(analysisAfter.obsolete.obsoleteArticleCount).toBe(0);
  });

  it("herberekent puur (legacy-terugvalpad) voor een sessie zonder bevroren FinalizedSessionResult, en gooit nooit een fout", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 3,
    });
    // Simuleert een sessie die COMPLETED werd vóór de data-integriteit-sprint
    // (dus zonder ooit een FinalizedSessionResult te krijgen) — de LEGACY
    // `completeSession`-methode op de repository, niet de services'
    // `finalize()`-pad.
    await repository.completeSession(session.id);

    const analysis = await analysisService.getSessionAnalysis(session.id);
    expect(analysis.kpis.totalStockValue).toBe(30); // 3 * €10
    expect(analysis.header.sessionId).toBe(session.id);
  });
});
