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

/**
 * v0.2 §8: "Excel-export roundtrip: exporteren en opnieuw importeren", met
 * echte fixtures waar nuttig. Dit test de VOLLEDIGE stack end-to-end op het
 * echte Lokeren-bestand: import -> maandtelling volledig aftellen -> export
 * -> opnieuw inlezen via de gewone import-adapter, en controleert dat de
 * nieuwe totale telling van deze cyclus de "Vorige telling" van de
 * volgende cyclus wordt (spec §5), terwijl artikelen die niet in scope
 * zaten (kwartaalartikelen tijdens een maandtelling) hun oude previousCount
 * behouden.
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

describe("Excel-exportroundtrip op het echte Lokeren-bestand", () => {
  it("een volledig afgewerkte maandtelling exporteert en importeert correct terug", async () => {
    const repository = new InMemoryCountingRepository();
    const importService = new ImportService(repository);
    const sessionService = new CountSessionService(repository);
    const countingService = new CountingService(repository);
    const exportService = new ExportService(repository, new ExcelStockResultExporter());

    const buffer = loadFixtureBuffer("Stocktelling_Lokeren_standaard.xlsx");
    const source = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Lokeren_standaard.xlsx");
    await importService.commitImport(await importService.prepareImport(source));

    const session = await sessionService.startSession("lokeren", "MONTHLY");
    expect(session.articleIds.length).toBeGreaterThan(0);

    const allArticles = await repository.getArticles("lokeren");
    const articleById = new Map(allArticles.map((a) => [a.id, a]));

    // Alles in scope tellen: standaard exact de oude "vorige telling"
    // (dus geen verschil), behalve twee artikelen die we bewust een nieuwe
    // waarde geven om een positief én een negatief verschil te forceren.
    const increasedId = session.articleIds[0];
    const decreasedId = session.articleIds[1];
    for (const articleId of session.articleIds) {
      const article = articleById.get(articleId);
      if (!article) throw new Error(`artikel ${articleId} niet gevonden`);
      let quantity = article.previousCount ?? 0;
      if (articleId === increasedId) quantity += 5;
      if (articleId === decreasedId) quantity = Math.max(0, quantity - 3);
      await countingService.recordCount({
        session,
        articleId,
        locationId: "lokeren:loc-1",
        quantity,
      });
    }
    await sessionService.completeSession(session.id);

    const exported = await exportService.exportSessionResults(session.id);
    expect(exported.fileName).toMatch(/^\d{4}-\d{2}-\d{2} - Stocktelling Lokeren\.xlsx$/);

    // Opnieuw inlezen zoals een echte volgende cyclus dat zou doen.
    const reimportedSource = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
    const reimportedOffice = await reimportedSource.loadOffice();
    const reimportedArticles = await reimportedSource.loadArticles(reimportedOffice);

    expect(reimportedOffice.name).toBe("Lokeren");
    // Zelfde totaal aantal artikelen als het origineel (spec: ARTIKEL blijft behouden).
    expect(reimportedArticles).toHaveLength(allArticles.length);

    const reimportedById = new Map(reimportedArticles.map((a) => [a.id, a]));

    // De twee bewust gewijzigde artikelen: hun NIEUWE totale telling is nu
    // de "vorige telling" voor de volgende cyclus.
    const increasedArticle = articleById.get(increasedId)!;
    const reimportedIncreased = reimportedById.get(increasedId);
    expect(reimportedIncreased?.previousCount).toBe((increasedArticle.previousCount ?? 0) + 5);

    const decreasedArticle = articleById.get(decreasedId)!;
    const reimportedDecreased = reimportedById.get(decreasedId);
    expect(reimportedDecreased?.previousCount).toBe(Math.max(0, (decreasedArticle.previousCount ?? 0) - 3));

    // Een kwartaalartikel (niet in de maandscope) behoudt zijn oude previousCount.
    const outOfScopeArticle = allArticles.find(
      (a) => a.countPeriod === "QUARTERLY" && !session.articleIds.includes(a.id),
    );
    expect(outOfScopeArticle).toBeDefined();
    const reimportedOutOfScope = reimportedById.get(outOfScopeArticle!.id);
    expect(reimportedOutOfScope?.previousCount).toBe(outOfScopeArticle!.previousCount);
  }, 30000);
});
