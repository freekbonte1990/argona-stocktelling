import { beforeEach, describe, expect, it } from "vitest";
import { AnalysisService, SessionNotAnalyzableError, SessionNotFoundError } from "./AnalysisService";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { ProductCategoryService } from "./ProductCategoryService";
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
    analysisService = new AnalysisService(repository, new ProductCategoryService(repository));
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

  it("een latere kostprijs-/bronproductgroep-/classificatiewijziging op het levende artikel raakt een reeds afgeronde analyse nooit (spec §13, kernvereiste van Sprint 2)", async () => {
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
    // De eenmalige migratie (spec §4) bootstrapt bij deze EERSTE aanroep een
    // categorie uit de bestaande bronproductgroep "Oude productgroep", en
    // wijst A1 daaraan toe — dat blijft hierna net zo goed bevroren t.o.v.
    // latere wijzigingen aan het levende artikel als elk ander veld.
    expect(analysisBefore.productCategories[0].productCategory).toBe("Oude productgroep");
    expect(analysisBefore.obsolete.obsoleteArticleCount).toBe(0);

    // Exact het scenario dat spec §13 verbiedt: een kostprijscorrectie,
    // bronproductgroepwijziging én OBSOLETE-classificatie op het ArticleDetail-
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
    // De vrije-tekst bronproductgroep wijzigde wel op het levende artikel,
    // maar dat verplaatst NOOIT stilzwijgend de canonieke categorietoewijzing
    // (spec §4: "verplaats geen individuele artikelen" buiten een expliciete
    // beheeractie) — de canonieke groepering blijft dus "Oude productgroep".
    expect(analysisAfter.productCategories[0].productCategory).toBe("Oude productgroep");
    expect(analysisAfter.obsolete.obsoleteArticleCount).toBe(0);
  });

  it("een latere canonieke Productgamma-herclassificatie werkt WEL retroactief door in een reeds afgeronde analyse (spec §11/§12, kernvereiste van Sprint 3.2)", async () => {
    // Bewust een TWEEDE artikel zonder bronproductgroep, zodat de eenmalige
    // migratie (spec §4) er niets aan toewijst — dat houdt dit scenario
    // zuiver gescheiden van de migratie-invariant hierboven.
    await repository.saveArticles([
      makeArticle({ articleNumber: "A2", costPrice: 20, productGroup: null }),
    ]);
    const session = await sessionService.startSession("office-1", "MONTHLY");
    // Beide scope-artikelen (A1 uit beforeEach + A2) moeten geteld worden
    // vóór afronden — anders blijft de sessie ACTIVE (SessionIncompleteError).
    await countingService.recordCount({
      session,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await countingService.recordCount({
      session,
      articleId: "office-1:A2",
      locationId: "office-1:loc-1",
      quantity: 4,
    });
    await countingService.completeLocation(session.id, "office-1:loc-1");
    await sessionService.completeSession(session.id);

    const analysisBefore = await analysisService.getSessionAnalysis(session.id);
    const rowBefore = analysisBefore.articles.find((a) => a.articleId === "office-1:A2")!;
    expect(rowBefore.productCategory).toBe("Niet ingedeeld");
    expect(rowBefore.productCategoryId).toBeNull();

    const productCategoryService = new ProductCategoryService(repository);
    // `addCategory` geeft de VOLLEDIGE lijst terug (incl. de reeds
    // gemigreerde "Oude productgroep"-categorie) — expliciet op naam opzoeken.
    const batterijen = (await productCategoryService.addCategory("office-1", "Batterijen")).find(
      (c) => c.name === "Batterijen",
    )!;
    await productCategoryService.assignArticles("office-1", ["office-1:A2"], batterijen.id);

    const analysisAfter = await analysisService.getSessionAnalysis(session.id);
    const rowAfter = analysisAfter.articles.find((a) => a.articleId === "office-1:A2")!;
    expect(rowAfter.productCategory).toBe("Batterijen");
    expect(rowAfter.productCategoryId).toBe(batterijen.id);
    // De bevroren hoeveelheid/kostprijs/voorraadwaarde blijven exact ongewijzigd — enkel de groepering verandert.
    expect(rowAfter.stockValue).toBe(rowBefore.stockValue);
    expect(analysisAfter.kpis.totalStockValue).toBe(analysisBefore.kpis.totalStockValue);
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
