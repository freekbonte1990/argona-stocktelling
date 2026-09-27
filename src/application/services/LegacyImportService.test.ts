import { beforeEach, describe, expect, it } from "vitest";
import { LegacyImportService } from "./LegacyImportService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import type { LegacyStockRow } from "../../domain/legacyImport";
import type { Article, Office } from "../../domain/types";

/**
 * Sprint 3.3 §3: applicatielaagtests voor `LegacyImportService`, met de
 * nadruk op wat de zuivere domeinlaag (`domain/legacyImport.test.ts`) niet
 * zelf kan testen — de daadwerkelijke PERSISTENTIE via `CountingRepository`,
 * en vooral de expliciet vereiste IDEMPOTENTIE van een herhaalde `commit`
 * (spec: "import moet idempotent zijn") over de repository heen (niet enkel
 * op het pure plan, zie `legacyImport.test.ts`'s eigen idempotentie-test).
 */

function makeOffice(id: string, name: string): Office {
  return {
    id,
    name,
    baseDate: "2026-01-01",
    locations: [],
  };
}

function makeArticle(overrides: Partial<Article> & Pick<Article, "id" | "officeId" | "articleNumber">): Article {
  return {
    officialArticleNumber: null,
    idType: null,
    description: "Bestaand artikel",
    productGroup: null,
    supplier: null,
    unit: null,
    costPrice: 1,
    rawCountPeriod: null,
    countPeriod: "MONTHLY",
    rawStatus: null,
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: null,
    assortmentActive: true,
    ...overrides,
  };
}

function makeRow(overrides: Partial<LegacyStockRow>): LegacyStockRow {
  return {
    periodKey: "2025-03-31",
    sourceProductGroup: "Batterijen",
    description: "Testartikel",
    articleNumber: "BATT001",
    originalCostPrice: 10,
    quantity: 5,
    obsolete: false,
    sourceRef: "TEST!A1",
    ...overrides,
  };
}

describe("LegacyImportService", () => {
  let repository: InMemoryCountingRepository;
  let service: LegacyImportService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    service = new LegacyImportService(repository);
    await repository.saveOffice(makeOffice("lokeren", "Lokeren"));
    await repository.saveArticles([
      makeArticle({ id: "lokeren:BATT001", officeId: "lokeren", articleNumber: "BATT001" }),
    ]);
  });

  it("preview berekent tegen de HUIDIGE, werkelijk bewaarde artikelstam, zonder iets te bewaren", async () => {
    const rows = [
      makeRow({ articleNumber: "BATT001", quantity: 10, originalCostPrice: 5 }), // matched
      makeRow({ articleNumber: "OLD999", description: "Uitgefaseerd", quantity: 3, originalCostPrice: 20 }), // legacy-only
    ];

    const preview = await service.preview("lokeren", rows);
    expect(preview.totalRows).toBe(2);
    expect(preview.totalMatched).toBe(2);
    expect(preview.totalUnresolved).toBe(0);

    // Niets bewaard: geen nieuw artikel, geen HISTORIE-regel.
    expect(await repository.getArticles("lokeren")).toHaveLength(1);
    expect(await repository.getStockHistoryEntries("lokeren")).toHaveLength(0);
  });

  it("commit bewaart enkel de NIEUWE (niet-matchende) artikelen en de volledige HISTORIE, zonder een bestaand levend artikel te overschrijven", async () => {
    const rows = [
      makeRow({ articleNumber: "BATT001", quantity: 10, originalCostPrice: 5 }),
      makeRow({ articleNumber: "OLD999", description: "Uitgefaseerd", quantity: 3, originalCostPrice: 20 }),
      makeRow({ articleNumber: null, description: "Nooit gezien", quantity: 1, originalCostPrice: 2 }),
    ];

    const result = await service.commit("lokeren", rows);
    expect(result.newArticleCount).toBe(2); // OLD999 + de onopgeloste rij
    expect(result.historyEntryCount).toBe(3);

    const articles = await repository.getArticles("lokeren");
    expect(articles.map((a) => a.id).sort()).toEqual([
      "lokeren:BATT001",
      "lokeren:LEGACY-nooit-gezien",
      "lokeren:OLD999",
    ]);

    // Het bestaande, levende artikel BATT001 blijft ONGEWIJZIGD (spec: legacy-
    // import overschrijft nooit levende mastergegevens).
    const batt001 = articles.find((a) => a.id === "lokeren:BATT001")!;
    expect(batt001.description).toBe("Bestaand artikel");
    expect(batt001.status).toBe("ACTIVE");
    expect(batt001.assortmentActive).toBe(true);

    // De nieuwe legacy-artikelen zijn inactief/niet in het assortiment.
    const old999 = articles.find((a) => a.id === "lokeren:OLD999")!;
    expect(old999.status).toBe("INACTIVE");
    expect(old999.assortmentActive).toBe(false);

    const history = await repository.getStockHistoryEntries("lokeren");
    expect(history).toHaveLength(3);
    expect(history.every((e) => e.status === "LEGACY" && e.source === "LEGACY_IMPORT")).toBe(true);
  });

  it("is idempotent over de repository heen: een tweede identieke commit levert geen duplicaten en geen extra artikelen op", async () => {
    const rows = [
      makeRow({ articleNumber: "OLD999", description: "Uitgefaseerd", quantity: 3, originalCostPrice: 20 }),
      makeRow({ articleNumber: null, description: "Nooit gezien", quantity: 1, originalCostPrice: 2 }),
    ];

    const first = await service.commit("lokeren", rows);
    expect(first.newArticleCount).toBe(2);

    // Tweede, IDENTIEKE commit: OLD999 en de onopgeloste rij bestaan nu al
    // als levend (weliswaar inactief) artikel, dus `newArticleCount` moet 0
    // zijn — geen enkel artikel wordt een tweede keer "nieuw" aangemaakt.
    const second = await service.commit("lokeren", rows);
    expect(second.newArticleCount).toBe(0);
    expect(second.historyEntryCount).toBe(2);

    const articles = await repository.getArticles("lokeren");
    expect(articles.map((a) => a.id).sort()).toEqual(["lokeren:BATT001", "lokeren:LEGACY-nooit-gezien", "lokeren:OLD999"]);

    const history = await repository.getStockHistoryEntries("lokeren");
    expect(history).toHaveLength(2); // geen duplicaten — nog steeds één regel per (periode, artikel)
  });

  it("een herimport met een BIJGEWERKTE hoeveelheid voor dezelfde periode overschrijft de HISTORIE-regel i.p.v. te dupliceren", async () => {
    const rowV1 = [makeRow({ articleNumber: "OLD999", description: "Uitgefaseerd", quantity: 3, originalCostPrice: 20 })];
    await service.commit("lokeren", rowV1);

    const rowV2 = [makeRow({ articleNumber: "OLD999", description: "Uitgefaseerd", quantity: 7, originalCostPrice: 20 })];
    await service.commit("lokeren", rowV2);

    const history = await repository.getStockHistoryEntries("lokeren");
    const forOld999 = history.filter((e) => e.articleId === "lokeren:OLD999");
    expect(forOld999).toHaveLength(1);
    expect(forOld999[0].totalCount).toBe(7);
  });
});
