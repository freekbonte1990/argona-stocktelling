import { computeSessionReview } from "../../domain/review";
import type { CountingRepository } from "../ports/CountingRepository";
import type { ExportedFile, StockResultExporter } from "../ports/StockResultExporter";

/**
 * Orkestreert de export van tellingsresultaten: haalt alles op via de
 * `CountingRepository`, berekent de review (domain/review.ts) en geeft die
 * door aan een `StockResultExporter` (vandaag: `ExcelStockResultExporter`).
 *
 * Kent zelf geen Excel- of IndexedDB-specifieke kennis — enkel de ports.
 * Een latere `EBuddyStockResultExporter` kan hier plug-and-play achter
 * gezet worden (zie docs/ARCHITECTURE.md).
 */
export class ExportService {
  private readonly repository: CountingRepository;
  private readonly exporter: StockResultExporter;

  constructor(repository: CountingRepository, exporter: StockResultExporter) {
    this.repository = repository;
    this.exporter = exporter;
  }

  async exportSessionResults(sessionId: string): Promise<ExportedFile> {
    const session = await this.repository.getSession(sessionId);
    if (!session) {
      throw new Error(`Sessie ${sessionId} niet gevonden.`);
    }
    const [office, allArticles, entries] = await Promise.all([
      this.repository.getOffice(session.officeId),
      this.repository.getArticles(session.officeId),
      this.repository.getCountEntries(sessionId),
    ]);
    if (!office) {
      throw new Error(`Kantoor ${session.officeId} niet gevonden.`);
    }

    const review = computeSessionReview(session, allArticles, office.locations, entries);

    return this.exporter.exportResults({ office, session, review, allArticles });
  }
}
