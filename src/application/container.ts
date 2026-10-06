import { IndexedDbCountingRepository } from "../adapters/storage/IndexedDbCountingRepository";
import { ExcelStockResultExporter } from "../adapters/excel/ExcelStockResultExporter";
import { ExcelLegacySnapshotExporter } from "../adapters/excel/ExcelLegacySnapshotExporter";
import { LegacySnapshotService } from "./services/LegacySnapshotService";
import { ImportService } from "./services/ImportService";
import { CountSessionService } from "./services/CountSessionService";
import { CountingService } from "./services/CountingService";
import { ExportService } from "./services/ExportService";
import { AnalysisService } from "./services/AnalysisService";
import { ComparisonService } from "./services/ComparisonService";
import { LocationAssignmentService } from "./services/LocationAssignmentService";
import { NewArticleService } from "./services/NewArticleService";
import { ProductCategoryService } from "./services/ProductCategoryService";
import { LegacyImportService } from "./services/LegacyImportService";
import { CentralHistorySyncService } from "./services/CentralHistorySyncService";
import { HttpCentralHistorySource } from "../adapters/centralHistory/HttpCentralHistorySource";
import { CentralMasterSyncService } from "./services/CentralMasterSyncService";
import { CentralDataSyncService } from "./services/CentralDataSyncService";
import { HttpCentralMasterSource } from "../adapters/centralMaster/HttpCentralMasterSource";

/**
 * Eenvoudige, handmatige dependency-"container" voor v0.1/v0.2: één
 * gedeelde repository-instantie (vandaag IndexedDB), en de services die
 * daarop bouwen. UI-schermen importeren enkel deze services, nooit Dexie of
 * xlsx rechtstreeks (behalve de importpagina, die een StockSource-adapter
 * aanmaakt — zie ui/pages/ImportPage.tsx).
 *
 * Wanneer eBuddy-adapters er zijn, verandert enkel deze file (en de
 * import-/exportpagina's): repository wordt bv.
 * `new EBuddyCountingRepository(...)`, en de exporter
 * `new EBuddyStockResultExporter(...)` — zie StockResultExporter-port en
 * docs/ARCHITECTURE.md.
 */
const repository = new IndexedDbCountingRepository();
const resultExporter = new ExcelStockResultExporter();

export const importService = new ImportService(repository);
export const countSessionService = new CountSessionService(repository);
export const countingService = new CountingService(repository);
export const exportService = new ExportService(repository, resultExporter);
export const productCategoryService = new ProductCategoryService(repository);
export const analysisService = new AnalysisService(repository, productCategoryService);
export const comparisonService = new ComparisonService(repository, productCategoryService);
export const legacySnapshotService = new LegacySnapshotService(
  repository,
  comparisonService,
  productCategoryService,
  new ExcelLegacySnapshotExporter(),
);
export const locationAssignmentService = new LocationAssignmentService(repository);
export const newArticleService = new NewArticleService(
  repository,
  locationAssignmentService,
  countingService,
  productCategoryService,
);
export const legacyImportService = new LegacyImportService(repository);
// Centrale read-only historiek (docs/CENTRAL_HISTORY.md). Migratie naar eBuddy =
// ENKEL deze ene regel: `new EBuddyCentralHistorySource(...)` i.p.v. de
// HTTP-adapter; sync-service, repository, Analyse en Vergelijken blijven gelijk.
export const centralHistorySyncService = new CentralHistorySyncService(
  repository,
  new HttpCentralHistorySource(),
);
// Centrale masterdata (docs/CENTRAL_MASTER.md): actuele stamdata, naast de historiek.
// Migratie naar eBuddy = ENKEL deze regel: `new EBuddyCentralMasterSource(...)` i.p.v. de
// HTTP-adapter; sync, repository en de rest van de app blijven gelijk.
export const centralMasterSyncService = new CentralMasterSyncService(
  repository,
  new HttpCentralMasterSource(),
);
// Volledige centrale sync (master → historiek → "Vorige telling"). Dit is wat de app aanroept.
export const centralDataSyncService = new CentralDataSyncService(
  repository,
  centralMasterSyncService,
  centralHistorySyncService,
);
export const countingRepository = repository;
