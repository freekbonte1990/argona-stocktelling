import {
  CENTRAL_MASTER_SCHEMA_VERSION,
  type CentralMasterArticle,
  type CentralMasterFile,
  type CentralOfficeSummary,
} from "../../domain/centralMasterFile";
import type { ProductCategory } from "../../domain/types";
import {
  CentralMasterError,
  type CentralMasterFetchResult,
  type CentralMasterSource,
  type FetchOfficeMasterOptions,
} from "../ports/CentralMasterSource";

/** Alleen voor tests: hulpbouwers voor de centrale masterdata. */

export const CATEGORY_KABELS: ProductCategory = { id: "cat-kabels", name: "Kabels", sortOrder: 1, active: true };
export const CATEGORY_LAMPEN: ProductCategory = { id: "cat-lampen", name: "Lampen", sortOrder: 2, active: true };

export function makeMasterArticle(articleNumber: string, overrides: Partial<CentralMasterArticle> = {}): CentralMasterArticle {
  return {
    articleNumber,
    officialArticleNumber: null,
    idType: null,
    description: `Centraal artikel ${articleNumber}`,
    unit: "stuk",
    supplier: "Leverancier",
    costPrice: 2.5,
    categoryId: CATEGORY_KABELS.id,
    sourceProductGroup: "KABEL",
    countPeriod: "MONTHLY",
    rawCountPeriod: "MAAND",
    status: "ACTIVE",
    rawStatus: "ACTIEF",
    assortmentActive: true,
    ...overrides,
  };
}

export function makeMaster(overrides: Partial<CentralMasterFile> = {}): CentralMasterFile {
  const officeId = overrides.officeId ?? "damme";
  return {
    schemaVersion: CENTRAL_MASTER_SCHEMA_VERSION,
    officeId,
    generatedAt: "2026-10-01T12:00:00.000Z",
    revision: "rev-0001",
    office: { name: "Damme", baseDate: "2026-01-01" },
    locations: [
      { id: `${officeId}:loc-1`, number: 1, name: "Magazijn", active: true },
      { id: `${officeId}:loc-2`, number: 2, name: "Bestelwagen", active: true },
    ],
    categories: [CATEGORY_KABELS, CATEGORY_LAMPEN],
    articles: [makeMasterArticle("A1"), makeMasterArticle("A2", { categoryId: CATEGORY_LAMPEN.id })],
    assignments: [
      { articleNumber: "A1", locationId: `${officeId}:loc-1`, active: true },
      { articleNumber: "A2", locationId: `${officeId}:loc-2`, active: true },
    ],
    deletedArticleNumbers: [],
    ...overrides,
  };
}

/** Programmeerbare bron: geeft een master, `unchanged` (als de revision gekend is), of gooit een fout. */
export class FakeCentralMasterSource implements CentralMasterSource {
  readonly label = "Fake centrale master";
  calls = 0;
  lastKnownRevision: string | null | undefined;
  private behaviour: CentralMasterFile | Error;
  indexBehaviour: CentralOfficeSummary[] | Error = [];

  constructor(behaviour: CentralMasterFile | Error) {
    this.behaviour = behaviour;
  }

  set(behaviour: CentralMasterFile | Error): void {
    this.behaviour = behaviour;
  }

  async fetchOfficeIndex(): Promise<CentralOfficeSummary[]> {
    if (this.indexBehaviour instanceof Error) throw this.indexBehaviour;
    return this.indexBehaviour;
  }

  async fetchOfficeMaster(_officeId: string, options: FetchOfficeMasterOptions = {}): Promise<CentralMasterFetchResult> {
    this.calls += 1;
    this.lastKnownRevision = options.knownRevision;
    if (this.behaviour instanceof Error) throw this.behaviour;
    if (options.knownRevision && options.knownRevision === this.behaviour.revision) return { kind: "unchanged" };
    return { kind: "master", file: structuredClone(this.behaviour) };
  }
}

export const masterOffline = (): CentralMasterError => new CentralMasterError("unavailable", "offline");
