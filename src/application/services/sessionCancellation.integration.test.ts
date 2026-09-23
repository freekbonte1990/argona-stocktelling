import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { CancelledSessionExportError, ExportService } from "./ExportService";
import type { ExportedFile, StockResultExportInput, StockResultExporter } from "../ports/StockResultExporter";
import type { Article, Office } from "../../domain/types";

/**
 * Lichte testdouble voor `StockResultExporter` — enkel om te verifiëren OF/
 * hoe vaak de exporter aangeroepen wordt, zonder van de echte Excel-adapter
 * af te hangen (die logica is elders al uitgebreid getest, zie
 * adapters/excel/rollingArchive.integration.test.ts). Bootst het "nieuw
 * tabblad gegenereerd"-gedrag na met een minimale, geldige `ExportedFile`.
 */
class FakeExporter implements StockResultExporter {
  readonly calls: StockResultExportInput[] = [];

  async exportResults(input: StockResultExportInput): Promise<ExportedFile> {
    this.calls.push(input);
    return {
      fileName: "test.xlsx",
      data: new ArrayBuffer(0),
      newHistoricalSheet: input.frozenSnapshotRows
        ? undefined
        : { sheetName: input.snapshot.sessionName, rows: [["dummy"]] },
    };
  }
}

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: "office-1:M1",
    officeId: "office-1",
    articleNumber: "M1",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 5,
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

/**
 * Sessielogica-fix, punt 7 ("rolling archive beschermen"): een CANCELLED
 * sessie mag NOOIT als officiële telling in het rollend archief terechtkomen.
 * Deze testset bewijst dat expliciet, en toont via de contrastcase
 * (COMPLETED) dat de bestaande, eerder gebouwde rolling-archive-functionaliteit
 * voor echte tellingen ongewijzigd blijft werken.
 */
describe("sessielogica-fix — CANCELLED sessies en het rollend archief", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;
  let exporter: FakeExporter;
  let exportService: ExportService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    exporter = new FakeExporter();
    exportService = new ExportService(repository, exporter);
    await repository.saveOffice(office);
    await repository.saveArticles([makeArticle({})]);
  });

  it("exportSessionResults gooit CancelledSessionExportError voor een geannuleerde sessie en roept de exporter nooit aan", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await sessionService.cancelSession(session.id);

    await expect(exportService.exportSessionResults(session.id)).rejects.toThrow(
      CancelledSessionExportError,
    );
    expect(exporter.calls).toHaveLength(0);
  });

  it("een geannuleerde sessie maakt geen named snapshot-tab en voegt niets toe aan HISTORIE", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await sessionService.cancelSession(session.id);

    await expect(exportService.exportSessionResults(session.id)).rejects.toThrow(
      CancelledSessionExportError,
    );

    expect(await repository.getHistoricalSheetSnapshots("office-1")).toHaveLength(0);
    expect(await repository.getStockHistoryEntries("office-1")).toHaveLength(0);
  });

  it("een geannuleerde sessie wijzigt Article.previousCount niet", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await sessionService.cancelSession(session.id);
    await expect(exportService.exportSessionResults(session.id)).rejects.toThrow(
      CancelledSessionExportError,
    );

    const articlesAfter = await repository.getArticles("office-1");
    expect(articlesAfter.find((a) => a.id === "office-1:M1")?.previousCount).toBe(5);
  });

  it("contrast: een COMPLETED sessie exporteert wél normaal, maakt wél een named snapshot-tab en groeit HISTORIE (bestaand rolling-archive-gedrag blijft werken)", async () => {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await countingService.completeLocation(session.id, "office-1:loc-1");
    await sessionService.completeSession(session.id);

    const exported = await exportService.exportSessionResults(session.id);
    expect(exported).toBeDefined();
    expect(exporter.calls).toHaveLength(1);

    const sheets = await repository.getHistoricalSheetSnapshots("office-1");
    expect(sheets).toHaveLength(1);
    const historyEntries = await repository.getStockHistoryEntries("office-1");
    expect(historyEntries.length).toBeGreaterThan(0);
  });
});
