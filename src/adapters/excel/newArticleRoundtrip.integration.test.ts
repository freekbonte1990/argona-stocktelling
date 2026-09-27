import { describe, expect, it } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import { ExportService } from "../../application/services/ExportService";
import { ImportService } from "../../application/services/ImportService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import { LocationAssignmentService } from "../../application/services/LocationAssignmentService";
import { NewArticleService } from "../../application/services/NewArticleService";
import { ProductCategoryService } from "../../application/services/ProductCategoryService";
import type { Article, Office } from "../../domain/types";

/**
 * v0.2.1 correctieronde §3C / §5: "Een nieuwe export en herimport mag het
 * nieuwe tijdelijke artikel niet verliezen of dupliceren." Dit test de
 * VOLLEDIGE cyclus: een tijdens een telling gevonden nieuw artikel ->
 * exporteren -> opnieuw inlezen via de normale import-adapter (zoals de
 * volgende telcyclus dat zou doen) -> nogmaals exporteren/herimporteren,
 * en controleert dat het tijdelijke artikel na elke stap precies éénmaal
 * voorkomt, met zijn locatiekoppeling intact.
 */
describe("Export/herimport-roundtrip van een nieuw (tijdelijk) artikel", () => {
  it("verliest of dupliceert het tijdelijke artikel niet, ook niet over meerdere cycli", async () => {
    const repository = new InMemoryCountingRepository();
    const sessionService = new CountSessionService(repository);
    const countingService = new CountingService(repository);
    const locationAssignmentService = new LocationAssignmentService(repository);
    const productCategoryService = new ProductCategoryService(repository);
    const newArticleService = new NewArticleService(
      repository,
      locationAssignmentService,
      countingService,
      productCategoryService,
    );
    const exportService = new ExportService(repository, new ExcelStockResultExporter());
    const importService = new ImportService(repository);

    const office: Office = {
      id: "damme",
      name: "Damme",
      baseDate: null,
      locations: [
        { id: "damme:loc-1", officeId: "damme", number: 1, name: "Rek 1", active: true },
        { id: "damme:loc-2", officeId: "damme", number: 2, name: "Rek 2", active: true },
      ],
    };
    const existingArticle: Article = {
      id: "damme:A1",
      officeId: "damme",
      articleNumber: "A1",
      officialArticleNumber: "A1",
      idType: "OFFICIEEL",
      description: "Bestaand artikel",
      productGroup: "GROEP",
      supplier: null,
      unit: "stuk",
      costPrice: 1,
      rawCountPeriod: "MAAND",
      countPeriod: "MONTHLY",
      rawStatus: "ACTIEF",
      status: "ACTIVE",
      previousCount: 5,
      sourceRow: 1,
    };
    await repository.saveOffice(office);
    await repository.saveArticles([existingArticle]);

    const session = await sessionService.startSession("damme", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "damme:A1",
      locationId: "damme:loc-1",
      quantity: 5,
    });

    // `addCategory` geeft de VOLLEDIGE lijst terug (incl. reeds bestaande,
    // eventueel via migratie gebootstrapte categorieën) — de nieuwe staat
    // achteraan, dus expliciet op naam opzoeken i.p.v. het eerste element aannemen.
    const nieuweCategorie = (await productCategoryService.addCategory("damme", "Nieuw")).find(
      (c) => c.name === "Nieuw",
    )!;
    const newArticle = await newArticleService.createArticleFoundDuringCounting(session, "damme:loc-2", {
      description: "Onderweg gevonden onderdeel",
      categoryId: nieuweCategorie.id,
      unit: "stuk",
      countPeriod: "MONTHLY",
      quantity: 6,
      comment: "Gevonden tijdens telling",
    });

    // Data-integriteit-sprint §2: een officiële export mag enkel voor een
    // AFGERONDE sessie — rond dus eerst beide locaties en de sessie zelf af
    // (dit test-scenario ging voorheen, vóór die regel bestond, ervan uit dat
    // je ook tussentijds/ACTIEF kon exporteren).
    await countingService.completeLocation(session.id, "damme:loc-1");
    await countingService.completeLocation(session.id, "damme:loc-2");
    await sessionService.completeSession(session.id);

    // --- Cyclus 1: exporteren en opnieuw inlezen ---
    let exported = await exportService.exportSessionResults(session.id);
    let source = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
    let preview = await importService.prepareImport(source);

    const tempRowsInArtikel = preview.articles.filter((a) => a.id === newArticle.id);
    expect(tempRowsInArtikel).toHaveLength(1);
    expect(tempRowsInArtikel[0].idType).toBe("TIJDELIJK");
    expect(tempRowsInArtikel[0].articleNumber).toBe(newArticle.articleNumber);

    await importService.commitImport(preview);

    const articlesAfterFirstReimport = await repository.getArticles("damme");
    expect(articlesAfterFirstReimport.filter((a) => a.id === newArticle.id)).toHaveLength(1);

    // De locatiekoppeling overleeft de herimport (import raakt assignments nooit aan).
    let assignments = await repository.getArticleLocationAssignments("damme");
    let activeForNewArticle = assignments.filter((a) => a.articleId === newArticle.id && a.active);
    expect(activeForNewArticle.map((a) => a.locationId)).toEqual(["damme:loc-2"]);

    // --- Cyclus 2: nogmaals exporteren en herimporteren — nog steeds geen duplicatie ---
    exported = await exportService.exportSessionResults(session.id);
    source = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
    preview = await importService.prepareImport(source);
    expect(preview.articles.filter((a) => a.id === newArticle.id)).toHaveLength(1);
    await importService.commitImport(preview);

    const articlesAfterSecondReimport = await repository.getArticles("damme");
    expect(articlesAfterSecondReimport.filter((a) => a.id === newArticle.id)).toHaveLength(1);
    expect(articlesAfterSecondReimport).toHaveLength(2); // A1 + het nieuwe artikel, nooit meer.

    assignments = await repository.getArticleLocationAssignments("damme");
    activeForNewArticle = assignments.filter((a) => a.articleId === newArticle.id && a.active);
    expect(activeForNewArticle.map((a) => a.locationId)).toEqual(["damme:loc-2"]);
  });
});
