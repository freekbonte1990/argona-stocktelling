import fs from "node:fs";
import path from "node:path";
import { ImportService } from "../src/application/services/ImportService";
import { CountSessionService } from "../src/application/services/CountSessionService";
import { CountingService } from "../src/application/services/CountingService";
import { ExportService } from "../src/application/services/ExportService";
import { InMemoryCountingRepository } from "../src/application/services/InMemoryCountingRepository";
import { ExcelStockResultExporter } from "../src/adapters/excel/ExcelStockResultExporter";
import { createExcelStockSourceFromBuffer } from "../src/adapters/excel/ExcelStockSource";

/**
 * Alleen voor tests: simuleert "toestel A" — importeert een echt fixture-
 * bestand, telt een volledige MONTHLY-sessie, rondt af en exporteert het
 * rollende Excelbestand (met HISTORIE-sheet + Sessie-ID). Gebruikt door de
 * publish-script-test en de centrale-historiek-integratietest.
 */
const FIXTURES_DIR = path.resolve(import.meta.dirname, "../test-fixtures");

export function loadFixtureBuffer(fileName: string): ArrayBuffer {
  const nodeBuffer = fs.readFileSync(path.join(FIXTURES_DIR, fileName));
  return nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
}

export async function produceDeviceAExport(fixtureFile: string, officeId: string, quantityBump = 1) {
  const repository = new InMemoryCountingRepository();
  const importService = new ImportService(repository);
  const sessionService = new CountSessionService(repository);
  const countingService = new CountingService(repository);
  const exportService = new ExportService(repository, new ExcelStockResultExporter());

  const source = createExcelStockSourceFromBuffer(loadFixtureBuffer(fixtureFile), fixtureFile);
  await importService.commitImport(await importService.prepareImport(source));

  const session = await sessionService.startSession(officeId, "MONTHLY");
  const articles = new Map((await repository.getArticles(officeId)).map((a) => [a.id, a]));
  for (const articleId of session.articleIds) {
    const article = articles.get(articleId);
    if (!article) throw new Error(`artikel ${articleId} niet gevonden`);
    await countingService.recordCount({
      session,
      articleId,
      locationId: `${officeId}:loc-1`,
      quantity: (article.previousCount ?? 0) + quantityBump,
    });
  }
  const office = await repository.getOffice(officeId);
  if (!office) throw new Error(`kantoor ${officeId} niet gevonden`);
  for (const location of office.locations.filter((l) => l.active)) {
    await countingService.completeLocation(session.id, location.id);
  }
  await sessionService.completeSession(session.id);
  const exported = await exportService.exportSessionResults(session.id);
  return { repository, session, exported };
}
