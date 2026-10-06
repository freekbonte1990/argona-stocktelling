import {
  buildLegacySnapshotView,
  legacySnapshotTitle,
  listLegacySnapshotItems,
  type LegacySnapshotListItem,
  type LegacySnapshotView,
} from "../../domain/legacySnapshotView";
import type { CountingRepository } from "../ports/CountingRepository";
import type { LegacySnapshotExporter } from "../ports/LegacySnapshotExporter";
import type { ExportedFile } from "../ports/StockResultExporter";
import type { ComparisonService } from "./ComparisonService";
import type { ProductCategoryService } from "./ProductCategoryService";

export interface LegacySnapshotDetail {
  officeId: string;
  officeName: string;
  title: string;
  view: LegacySnapshotView;
}

/**
 * Read-only detail + Excel-export van een legacy "Historische snapshot".
 * Hergebruikt de bestaande synthetische snapshotlogica
 * (`ComparisonService#getLegacyPeriodSnapshot` → `buildLegacyPeriodSnapshot`);
 * schrijft nooit iets weg en maakt nooit een `CountSession`.
 */
export class LegacySnapshotService {
  private readonly repository: CountingRepository;
  private readonly comparisonService: ComparisonService;
  private readonly productCategoryService: ProductCategoryService;
  private readonly exporter: LegacySnapshotExporter;

  constructor(
    repository: CountingRepository,
    comparisonService: ComparisonService,
    productCategoryService: ProductCategoryService,
    exporter: LegacySnapshotExporter,
  ) {
    this.repository = repository;
    this.comparisonService = comparisonService;
    this.productCategoryService = productCategoryService;
    this.exporter = exporter;
  }

  async listForOffice(officeId: string): Promise<LegacySnapshotListItem[]> {
    return listLegacySnapshotItems(await this.repository.getStockHistoryEntries(officeId));
  }

  async getDetail(officeId: string, legacySnapshotId: string): Promise<LegacySnapshotDetail> {
    const [office, input, categoryResolution] = await Promise.all([
      this.repository.getOffice(officeId),
      this.comparisonService.getLegacyPeriodSnapshot(officeId, legacySnapshotId),
      this.productCategoryService.buildCategoryResolution(officeId),
    ]);
    if (!office) throw new Error(`Kantoor ${officeId} niet gevonden.`);
    const periodLabel = input.sessionName.replace(/^LEGACY\s+/, "");
    return {
      officeId,
      officeName: office.name,
      title: legacySnapshotTitle(periodLabel),
      view: buildLegacySnapshotView(officeId, periodLabel, input.snapshot, categoryResolution),
    };
  }

  async exportToExcel(officeId: string, legacySnapshotId: string): Promise<ExportedFile> {
    const detail = await this.getDetail(officeId, legacySnapshotId);
    return this.exporter.exportSnapshot({ officeName: detail.officeName, view: detail.view });
  }
}
