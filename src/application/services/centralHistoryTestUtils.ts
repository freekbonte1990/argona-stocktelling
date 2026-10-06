import type { CentralHistoryFile } from "../../domain/centralHistoryFile";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";
import type { Article, Office } from "../../domain/types";
import { CentralHistoryError, type CentralHistorySource } from "../ports/CentralHistorySource";

/** Alleen voor tests (net als `adapters/excel/testWorkbook.ts`): hulpbouwers voor de centrale historiek. */

export function makeOffice(id = "damme", name = "Damme"): Office {
  return {
    id,
    name,
    baseDate: "2026-01-01",
    locations: [1, 2].map((n) => ({
      id: `${id}:loc-${n}`,
      officeId: id,
      number: n,
      name: `Locatie ${n}`,
      active: true,
    })),
  };
}

export function makeArticle(officeId: string, articleNumber: string): Article {
  return {
    id: `${officeId}:${articleNumber}`,
    officeId,
    articleNumber,
    officialArticleNumber: null,
    idType: null,
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
  };
}

export function makeEntry(overrides: Partial<StockHistoryEntry> = {}): StockHistoryEntry {
  return {
    countDate: "2026-08-31",
    sessionType: "MONTHLY",
    sessionName: "2026-08 Maand",
    articleId: "damme:A1",
    articleNumber: "A1",
    description: "Artikel A1",
    totalCount: 10,
    previousCount: 4,
    differenceQuantity: 6,
    costPrice: 2,
    differenceAmount: 12,
    status: "GETELD",
    locationNames: ["Locatie 1"],
    sourceSessionId: "session-aug",
    ...overrides,
  };
}

export function makeFile(
  entries: StockHistoryEntry[],
  overrides: Partial<CentralHistoryFile> = {},
): CentralHistoryFile {
  return {
    schemaVersion: 1,
    officeId: "damme",
    generatedAt: "2026-10-01T12:00:00.000Z",
    deletedSessionIds: [],
    entries,
    ...overrides,
  };
}

/** Programmeerbare bron: geeft een bestand, of gooit een `CentralHistoryError`/gewone fout. */
export class FakeCentralHistorySource implements CentralHistorySource {
  readonly label = "Fake centrale bron";
  calls = 0;
  private behaviour: CentralHistoryFile | Error;

  constructor(behaviour: CentralHistoryFile | Error) {
    this.behaviour = behaviour;
  }

  set(behaviour: CentralHistoryFile | Error): void {
    this.behaviour = behaviour;
  }

  async fetchOfficeHistory(): Promise<CentralHistoryFile> {
    this.calls += 1;
    if (this.behaviour instanceof Error) throw this.behaviour;
    return this.behaviour;
  }
}

export const offline = (): CentralHistoryError => new CentralHistoryError("unavailable", "offline");
