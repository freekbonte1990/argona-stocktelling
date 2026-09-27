import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { ImportService } from "../../application/services/ImportService";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import { ExportService } from "../../application/services/ExportService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import { ProductCategoryService } from "../../application/services/ProductCategoryService";
import { allProductCategoriesInOrder } from "../../domain/productCategory";

/**
 * Sprint 3.2.1-architectuurfix §14 (Excel portability — HARDE
 * acceptatievoorwaarde, expliciet gevraagd bij de architectuurreview):
 * bewijst dat de bedrijfsbrede/globale "Productgamma"-laag (zie
 * `ProductCategory` in domain/types.ts) de volledige keten
 * `tablet/browser A -> import -> Productgamma's beheren (hernoemen/
 * herordenen/deactiveren/retroactief herclassificeren) -> tellen -> afronden
 * -> Excel export -> volledig lege tablet/browser B -> import` overleeft,
 * met TWEE écht onafhankelijke `CountingRepository`-instanties — zelfde
 * "fresh repository" opzet als `freshRepositoryRoundtrip.integration.test.ts`
 * (production-pilot-readiness sprint punt 2), nu toegepast op Productgamma's.
 *
 * Acceptatiecriterium (letterlijk uit de architectuurreview): "Na import in
 * een volledig lege database moeten exact dezelfde category IDs / names /
 * order / active/inactive states / article assignments terugkomen."
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../test-fixtures");

function loadFixtureBuffer(fileName: string): ArrayBuffer {
  const filePath = path.join(FIXTURES_DIR, fileName);
  const nodeBuffer = fs.readFileSync(filePath);
  return nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
}

/** Bouwt een volledig bedraad "toestel" (repository + services) — gebruikt voor zowel A als B. */
function makeDevice() {
  const repository = new InMemoryCountingRepository();
  return {
    repository,
    importService: new ImportService(repository),
    sessionService: new CountSessionService(repository),
    countingService: new CountingService(repository),
    exportService: new ExportService(repository, new ExcelStockResultExporter()),
    categoryService: new ProductCategoryService(repository),
  };
}

describe("Productgamma Excel-portability (Sprint 3.2.1 §14 — harde acceptatievoorwaarde)", () => {
  it(
    "Repository A migreert/beheert Productgamma's (hernoemen/herordenen/deactiveren/retroactief herclassificeren), exporteert; een volledig lege Repository B importeert dat bestand en krijgt exact dezelfde category IDs/names/order/active-states/article-toewijzingen terug",
    async () => {
      // ---- Repository A: import + eenmalige migratiebootstrap ----
      const deviceA = makeDevice();
      const buffer = loadFixtureBuffer("Stocktelling_Lokeren_standaard.xlsx");
      const sourceA = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Lokeren_standaard.xlsx");
      await deviceA.importService.commitImport(await deviceA.importService.prepareImport(sourceA));

      // Bronbestand heeft GEEN PRODUCTGAMMAS-sheet (fixture van vóór Sprint
      // 3.2) — de eenmalige migratiebootstrap (spec §4) moet hier dus zelf
      // categorieën aanmaken uit de bestaande `Productgroep`-kolom.
      const bootstrapped = await deviceA.categoryService.listCategories("lokeren");
      expect(bootstrapped.map((c) => c.name).sort()).toEqual(
        ["Batterijen", "ELEKTRISCH MATERIAAL", "Laadpalen", "Montagemateriaal", "Omvormers", "Zonnepanelen"].sort(),
      );

      const byName = (name: string) => bootstrapped.find((c) => c.name === name)!;
      const batterijen = byName("Batterijen");
      const omvormers = byName("Omvormers");

      // --- Beheeracties op Repository A (spec §5/§6/§7): hernoemen, ---
      // --- herordenen, deactiveren, en één artikel RETROACTIEF ---
      // --- herclassificeren naar een ANDERE categorie dan zijn eigen ---
      // --- bronproductgroep (spec: "management-classificatie mag met ---
      // --- terugwerkende kracht wijzigen"). ---
      await deviceA.categoryService.renameCategory("lokeren", batterijen.id, "Batterijen (herzien)");
      await deviceA.categoryService.setCategoryActive("lokeren", omvormers.id, false);
      const currentOrder = allProductCategoriesInOrder(
        await deviceA.categoryService.listCategories("lokeren"),
      ).map((c) => c.id);
      const reorderedIds = [...currentOrder].reverse();
      await deviceA.categoryService.reorderCategories("lokeren", reorderedIds);

      // "LP0101001" heeft bronproductgroep "Laadpalen" — retroactief
      // verplaatst naar "Batterijen (herzien)". `Article.productGroup`
      // (Bronproductgroep) blijft hierdoor ONGEWIJZIGD "Laadpalen" — enkel
      // `categoryId` verandert.
      const reclassifiedArticleId = "lokeren:LP0101001";
      await deviceA.categoryService.assignArticles("lokeren", [reclassifiedArticleId], batterijen.id);

      const categoriesBeforeExport = allProductCategoriesInOrder(
        await deviceA.repository.getProductCategories(),
      );
      const articlesBeforeExport = await deviceA.repository.getArticles("lokeren");
      const reclassifiedArticleBeforeExport = articlesBeforeExport.find((a) => a.id === reclassifiedArticleId);
      expect(reclassifiedArticleBeforeExport?.categoryId).toBe(batterijen.id);
      expect(reclassifiedArticleBeforeExport?.productGroup).toBe("Laadpalen"); // bronproductgroep ongewijzigd

      // --- Tellen + afronden + exporteren (export vereist een COMPLETED sessie) ---
      const session = await deviceA.sessionService.startSession("lokeren", "MONTHLY");
      for (const articleId of session.articleIds) {
        const article = articlesBeforeExport.find((a) => a.id === articleId);
        if (!article) throw new Error(`artikel ${articleId} niet gevonden`);
        await deviceA.countingService.recordCount({
          session,
          articleId,
          locationId: "lokeren:loc-1",
          quantity: article.previousCount ?? 0,
        });
      }
      const officeWithLocations = await deviceA.repository.getOffice("lokeren");
      if (!officeWithLocations) throw new Error("kantoor 'lokeren' niet gevonden in Repository A");
      for (const location of officeWithLocations.locations.filter((l) => l.active)) {
        await deviceA.countingService.completeLocation(session.id, location.id);
      }
      await deviceA.sessionService.completeSession(session.id);
      const exported = await deviceA.exportService.exportSessionResults(session.id);

      // ---- Repository B: VOLLEDIG LEEG (nooit eerder iets van dit kantoor gezien) ----
      const deviceB = makeDevice();
      expect(await deviceB.repository.getOffice("lokeren")).toBeUndefined();
      expect(await deviceB.repository.getProductCategories()).toHaveLength(0);

      const sourceB = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
      await deviceB.importService.commitImport(await deviceB.importService.prepareImport(sourceB));

      // --- Exact dezelfde category IDs/names/order/active-states ---
      const categoriesB = allProductCategoriesInOrder(await deviceB.repository.getProductCategories());
      expect(categoriesB).toHaveLength(categoriesBeforeExport.length);
      expect(categoriesB).toEqual(categoriesBeforeExport);

      // Expliciet ook de individuele, bewuste beheeracties: hernoemen, volgorde, deactiveren.
      const batterijenB = categoriesB.find((c) => c.id === batterijen.id);
      expect(batterijenB?.name).toBe("Batterijen (herzien)");
      const omvormersB = categoriesB.find((c) => c.id === omvormers.id);
      expect(omvormersB?.active).toBe(false);
      expect(categoriesB.map((c) => c.id)).toEqual(reorderedIds);

      // --- Exact dezelfde article -> category-toewijzingen ---
      const articlesB = await deviceB.repository.getArticles("lokeren");
      expect(articlesB).toHaveLength(articlesBeforeExport.length);
      const categoryIdByArticleIdA = new Map(articlesBeforeExport.map((a) => [a.id, a.categoryId ?? null]));
      for (const articleB of articlesB) {
        expect(articleB.categoryId ?? null).toBe(categoryIdByArticleIdA.get(articleB.id) ?? null);
      }
      // Expliciet de retroactief herclassificeerde: naar Batterijen, bron ongewijzigd.
      const reclassifiedArticleB = articlesB.find((a) => a.id === reclassifiedArticleId);
      expect(reclassifiedArticleB?.categoryId).toBe(batterijen.id);
      expect(reclassifiedArticleB?.productGroup).toBe("Laadpalen");

      // --- Idempotent: een herhaalde `listCategories` in Repository B mag ---
      // --- deze zonet geïmporteerde, volledige lijst niet nog eens ---
      // --- uitbreiden/dupliceren (Office.categoriesMigrated-gate). ---
      const afterListB = await deviceB.categoryService.listCategories("lokeren");
      expect(afterListB).toHaveLength(categoriesBeforeExport.length);
    },
    30000,
  );
});
