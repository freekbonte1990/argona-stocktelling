import type { LegacySnapshotView } from "../../domain/legacySnapshotView";
import type { ExportedFile } from "./StockResultExporter";

export interface LegacySnapshotExportInput {
  officeName: string;
  view: LegacySnapshotView;
}

/** Schrijft één (immutable) historische snapshot weg als los bestand — raakt nooit het rollend archief. */
export interface LegacySnapshotExporter {
  exportSnapshot(input: LegacySnapshotExportInput): Promise<ExportedFile>;
}
