import { beforeEach, describe, expect, it } from "vitest";
import type { StockSource } from "../ports/StockSource";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";
import type { Article, Office } from "../../domain/types";
import { CentralMasterSyncService } from "./CentralMasterSyncService";
import { ImportService } from "./ImportService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { ProductCategoryService } from "./ProductCategoryService";
import { makeArticle, makeOffice } from "./centralHistoryTestUtils";
import { CATEGORY_KABELS, FakeCentralMasterSource, makeMaster, makeMasterArticle } from "./centralMasterTestUtils";

class FakeStockSource implements StockSource {
  readonly sourceLabel = "excel.xlsx";
  private readonly office: Office;
  private readonly articles: Article[];
  constructor(office: Office, articles: Article[]) {
    this.office = office;
    this.articles = articles;
  }
  async loadOffice() {
    return this.office;
  }
  async loadArticles() {
    return this.articles;
  }
  async loadHistory(): Promise<StockHistoryEntry[]> {
    return [];
  }
}

let repository: InMemoryCountingRepository;
let master: FakeCentralMasterSource;
let sync: CentralMasterSyncService;

beforeEach(async () => {
  repository = new InMemoryCountingRepository();
  master = new FakeCentralMasterSource(makeMaster());
  sync = new CentralMasterSyncService(repository, master, { now: () => new Date("2026-10-06T08:00:00.000Z") });
});

describe("productgamma-migratie is uitgeschakeld voor een centraal beheerd kantoor", () => {
  it("een Excel-adoptie-toestel: na de master draait de eenmalige bootstrap NOOIT (ook niet als de vlag ontbreekt)", async () => {
    // Toestel dat via Excel werd opgezet: artikelen met bronproductgroep, nog niet gemigreerd.
    await repository.saveOffice({ ...makeOffice(), categoriesMigrated: false });
    await repository.saveArticles([
      { ...makeArticle("damme", "A1"), productGroup: "ZONNEPANELEN" },
      { ...makeArticle("damme", "A2"), productGroup: "LAADPALEN" },
    ]);
    await sync.syncOffice("damme", { force: true });

    // Een latere Excel-import die de vlag laat vallen (office overschreven):
    const office = (await repository.getOffice("damme"))!;
    await repository.saveOffice({ ...office, categoriesMigrated: undefined });

    const categories = new ProductCategoryService(repository);
    const listed = await categories.listCategories("damme");
    expect(listed.map((c) => c.name).sort()).toEqual(["Kabels", "Lampen"]);
    // Geen lokaal willekeurige gamma's uit 'ZONNEPANELEN'/'LAADPALEN':
    expect((await repository.getProductCategories()).map((c) => c.name).sort()).toEqual(["Kabels", "Lampen"]);
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.categoryId).toBe("cat-kabels");
  });

  it("een niet-centraal kantoor migreert nog altijd gewoon (geen regressie)", async () => {
    await repository.saveOffice({ ...makeOffice("lokeren", "Lokeren"), categoriesMigrated: false });
    await repository.saveArticles([{ ...makeArticle("lokeren", "Z1"), productGroup: "ZONNEPANELEN" }]);
    const categories = new ProductCategoryService(repository);
    expect((await categories.listCategories("lokeren")).map((c) => c.name)).toContain("ZONNEPANELEN");
  });

  it("lokaal bestaand productgamma met dezelfde naam maar ander id wordt bij adoptie samengevoegd (alle kantoren)", async () => {
    const localKabels = { id: "lokaal-uuid", name: "Kabels", sortOrder: 7, active: true };
    await repository.saveProductCategories([localKabels]);
    await repository.saveOffice({ ...makeOffice(), categoriesMigrated: true });
    await repository.saveOffice({ ...makeOffice("lokeren", "Lokeren"), categoriesMigrated: true });
    await repository.saveArticles([{ ...makeArticle("damme", "A1"), categoryId: localKabels.id }]);
    await repository.saveArticles([{ ...makeArticle("lokeren", "Z1"), categoryId: localKabels.id }]);

    await sync.syncOffice("damme", { force: true });

    expect((await repository.getProductCategories()).map((c) => c.id).sort()).toEqual(["cat-kabels", "cat-lampen"]);
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.categoryId).toBe(CATEGORY_KABELS.id);
    expect((await repository.getArticles("lokeren"))[0].categoryId).toBe(CATEGORY_KABELS.id);
  });
});

describe("TMP-artikelen en lokale uitzonderingsflows blijven werken na een master-sync", () => {
  it("een lokaal TMP-artikel (met koppeling) overleeft meerdere master-updates ongewijzigd", async () => {
    await sync.syncOffice("damme", { force: true, selectOffice: true });
    const tmp: Article = {
      ...makeArticle("damme", "TMP-DAM-0001"),
      idType: "TIJDELIJK",
      description: "Uit het veld",
      previousCount: 4,
      categoryId: null,
    };
    await repository.saveArticles([tmp]);
    await repository.saveArticleLocationAssignment({
      id: "damme:damme:TMP-DAM-0001:damme:loc-1",
      officeId: "damme",
      articleId: tmp.id,
      locationId: "damme:loc-1",
      active: true,
      lastSeenAt: "2026-10-05T10:00:00.000Z",
    });

    master.set(makeMaster({ revision: "rev-0002", articles: [makeMasterArticle("A1")], assignments: [] }));
    await sync.syncOffice("damme", { force: true });
    master.set(makeMaster({ revision: "rev-0003", articles: [makeMasterArticle("A1"), makeMasterArticle("A9")], assignments: [] }));
    await sync.syncOffice("damme", { force: true });

    expect((await repository.getArticles("damme")).find((a) => a.id === tmp.id)).toEqual(tmp);
    const assignment = (await repository.getArticleLocationAssignments("damme")).find((a) => a.articleId === tmp.id);
    expect(assignment).toMatchObject({ active: true, lastSeenAt: "2026-10-05T10:00:00.000Z" });
    // A2 (centraal verdwenen) is enkel inactief geworden, niet weg:
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A2")?.assortmentActive).toBe(false);
  });
});

describe("Excel-import blijft een fallback voor een centraal beheerd kantoor", () => {
  it("de import-preview meldt 'centraal beheerd'; na de import wordt de revision ongeldig en past de volgende sync de master opnieuw toe", async () => {
    await sync.syncOffice("damme", { force: true, selectOffice: true });
    const importService = new ImportService(repository);
    const source = new FakeStockSource(makeOffice(), [{ ...makeArticle("damme", "EXCEL"), description: "Alleen in Excel" }]);

    const preview = await importService.prepareImport(source);
    expect(preview.existing?.centrallyManaged).toBe(true);
    await importService.commitImport(preview);

    expect(await repository.getCentralMasterStatus("damme")).toMatchObject({ revision: null, pendingRevision: null });
    // Het kantoor blijft als 'ooit centraal' bekend, dus de gamma-bootstrap blijft uit:
    expect((await repository.getCentralMasterStatus("damme"))?.appliedAt).not.toBeNull();

    const result = await sync.syncOffice("damme"); // zonder force: revision null → geen 304, geen throttle
    expect(result.outcome).toBe("applied");
    const articles = await repository.getArticles("damme");
    expect(articles.map((a) => a.articleNumber).sort()).toEqual(["A1", "A2", "EXCEL"]);
    // Het kantoor was al centraal beheerd: een lokaal artikel zonder centrale oorsprong wordt niet gedeactiveerd.
    expect(articles.find((a) => a.articleNumber === "EXCEL")?.assortmentActive).not.toBe(false);
  });

  it("een kantoor zonder centrale master toont geen 'centraal beheerd'-melding", async () => {
    const importService = new ImportService(repository);
    const source = new FakeStockSource(makeOffice("lokeren", "Lokeren"), [makeArticle("lokeren", "Z1")]);
    await importService.commitImport(await importService.prepareImport(source));
    expect((await importService.prepareImport(source)).existing?.centrallyManaged).toBe(false);
  });
});
