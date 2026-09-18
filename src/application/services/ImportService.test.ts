import { beforeEach, describe, expect, it } from "vitest";
import { ImportService } from "./ImportService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import type { StockSource } from "../ports/StockSource";
import type { Article, Office } from "../../domain/types";

class FakeStockSource implements StockSource {
  readonly sourceLabel: string;
  private readonly office: Office;
  private readonly articles: Article[];

  constructor(office: Office, articles: Article[], sourceLabel: string) {
    this.office = office;
    this.articles = articles;
    this.sourceLabel = sourceLabel;
  }

  async loadOffice(): Promise<Office> {
    return this.office;
  }
  async loadArticles(): Promise<Article[]> {
    return this.articles;
  }
}

function makeOffice(id: string, name: string, locationNames: string[]): Office {
  return {
    id,
    name,
    baseDate: "2026-01-01",
    locations: [1, 2, 3, 4, 5].map((n, i) => ({
      id: `${id}:loc-${n}`,
      officeId: id,
      number: n as 1 | 2 | 3 | 4 | 5,
      name: locationNames[i] ?? `Locatie ${n}`,
    })),
  };
}

function makeArticle(officeId: string, articleNumber: string): Article {
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
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
  };
}

describe("ImportService — meerdere kantoren, niet stilletjes overschrijven", () => {
  let repository: InMemoryCountingRepository;
  let importService: ImportService;

  beforeEach(() => {
    repository = new InMemoryCountingRepository();
    importService = new ImportService(repository);
  });

  it("meldt geen bestaand kantoor bij een eerste import", async () => {
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1")],
      "antwerpen.xlsx",
    );
    const preview = await importService.prepareImport(source);
    expect(preview.existing).toBeNull();
  });

  it("meldt een bestaand kantoor bij een herimport, met aantal artikelen en importdatum", async () => {
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A2")],
      "antwerpen.xlsx",
    );
    await importService.commitImport(await importService.prepareImport(source));

    const secondPreview = await importService.prepareImport(source);
    expect(secondPreview.existing).not.toBeNull();
    expect(secondPreview.existing?.articleCount).toBe(2);
    expect(secondPreview.existing?.office.name).toBe("Antwerpen");
    expect(secondPreview.existing?.importedAt).not.toBeNull();
  });

  it("bewaart aangepaste locatienamen over een herimport heen (geen stille overschrijving)", async () => {
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn", "", "", "", ""]),
      [makeArticle("antwerpen", "A1")],
      "antwerpen.xlsx",
    );
    await importService.commitImport(await importService.prepareImport(source));

    // Gebruiker hernoemt Locatie 2 via het instellingenscherm.
    const office = await repository.getOffice("antwerpen");
    if (!office) throw new Error("office niet gevonden");
    office.locations[1].name = "Buitenmagazijn";
    await repository.saveOffice(office);

    // Nieuwe import van hetzelfde kantoor, met andere locatienamen in het bestand.
    const secondSource = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Ander magazijn", "Weer iets anders", "", "", ""]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A2")],
      "antwerpen-v2.xlsx",
    );
    const summary = await importService.commitImport(await importService.prepareImport(secondSource));

    expect(summary.office.locations[1].name).toBe("Buitenmagazijn");
    expect(summary.totalArticles).toBe(2);
  });

  it("een import van kantoor B laat kantoor A volledig ongemoeid", async () => {
    const antwerpen = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A2")],
      "antwerpen.xlsx",
    );
    const lokeren = new FakeStockSource(
      makeOffice("lokeren", "Lokeren", ["Depot"]),
      [makeArticle("lokeren", "L1")],
      "lokeren.xlsx",
    );

    await importService.commitImport(await importService.prepareImport(antwerpen));
    await importService.commitImport(await importService.prepareImport(lokeren));

    const antwerpenArticles = await repository.getArticles("antwerpen");
    const lokerenArticles = await repository.getArticles("lokeren");
    expect(antwerpenArticles).toHaveLength(2);
    expect(lokerenArticles).toHaveLength(1);
    expect((await repository.getOffice("antwerpen"))?.name).toBe("Antwerpen");
    expect((await repository.getOffice("lokeren"))?.name).toBe("Lokeren");
  });
});
