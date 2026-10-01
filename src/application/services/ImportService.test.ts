import { beforeEach, describe, expect, it } from "vitest";
import { ImportService } from "./ImportService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { AnalysisService } from "./AnalysisService";
import { ComparisonService } from "./ComparisonService";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { ProductCategoryService } from "./ProductCategoryService";
import type { StockSource } from "../ports/StockSource";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";
import type { Article, Office } from "../../domain/types";

class FakeStockSource implements StockSource {
  readonly sourceLabel: string;
  private readonly office: Office;
  private readonly articles: Article[];
  private readonly history: StockHistoryEntry[];

  constructor(office: Office, articles: Article[], sourceLabel: string, history: StockHistoryEntry[] = []) {
    this.office = office;
    this.articles = articles;
    this.sourceLabel = sourceLabel;
    this.history = history;
  }

  async loadOffice(): Promise<Office> {
    return this.office;
  }
  async loadArticles(): Promise<Article[]> {
    return this.articles;
  }
  async loadHistory(): Promise<StockHistoryEntry[]> {
    return this.history;
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
      number: n,
      name: locationNames[i] ?? `Locatie ${n}`,
      active: true,
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

describe("ImportService — Sprint 3.3 §1: assortiment-diff bij herimport", () => {
  let repository: InMemoryCountingRepository;
  let importService: ImportService;

  beforeEach(() => {
    repository = new InMemoryCountingRepository();
    importService = new ImportService(repository);
  });

  it("een artikel dat verdwijnt uit een nieuw mastermodel wordt inactief (niet verwijderd)", async () => {
    const first = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A2")],
      "antwerpen.xlsx",
    );
    await importService.commitImport(await importService.prepareImport(first));

    // Nieuw mastermodel: A2 komt er niet meer in voor (uitgefaseerd product), A3 is nieuw.
    const second = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A3")],
      "antwerpen-v2.xlsx",
    );
    const summary = await importService.commitImport(await importService.prepareImport(second));
    expect(summary.newlyInactiveArticleCount).toBe(1);

    const articles = await repository.getArticles("antwerpen");
    expect(articles).toHaveLength(3); // A1, A2 (nu inactief), A3 — nooit verwijderd.
    const a1 = articles.find((a) => a.articleNumber === "A1");
    const a2 = articles.find((a) => a.articleNumber === "A2");
    const a3 = articles.find((a) => a.articleNumber === "A3");
    expect(a1?.assortmentActive).toBe(true);
    expect(a2?.assortmentActive).toBe(false);
    expect(a3?.assortmentActive).toBe(true);
  });

  it("een herimport van een volledig eigen export (alle artikelen aanwezig, incl. al-inactieve) maakt niemand stilzwijgend terug actief", async () => {
    const first = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), { ...makeArticle("antwerpen", "A2"), assortmentActive: false }],
      "antwerpen.xlsx",
    );
    await importService.commitImport(await importService.prepareImport(first));

    // Een "eigen export" bevat het VOLLEDIGE lokale artikelbestand, met de
    // assortimentswaarde expliciet meegegeven (zoals de "Assortiment
    // actief"-Excelkolom dat zou doen) — A2 blijft hier dus expliciet inactief.
    const reimport = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [
        { ...makeArticle("antwerpen", "A1"), assortmentActive: true },
        { ...makeArticle("antwerpen", "A2"), assortmentActive: false },
      ],
      "antwerpen-export.xlsx",
    );
    const summary = await importService.commitImport(await importService.prepareImport(reimport));
    expect(summary.newlyInactiveArticleCount).toBe(0);

    const articles = await repository.getArticles("antwerpen");
    expect(articles.find((a) => a.articleNumber === "A2")?.assortmentActive).toBe(false);
    expect(articles.find((a) => a.articleNumber === "A1")?.assortmentActive).toBe(true);
  });

  it("een gloednieuw kantoor krijgt gewoon 0 nieuw-inactieve artikelen (niets was eerder gekend)", async () => {
    const source = new FakeStockSource(
      makeOffice("damme", "Damme", ["Magazijn"]),
      [makeArticle("damme", "D1")],
      "damme.xlsx",
    );
    const summary = await importService.commitImport(await importService.prepareImport(source));
    expect(summary.newlyInactiveArticleCount).toBe(0);
    expect((await repository.getArticles("damme"))[0]?.assortmentActive).toBe(true);
  });
});

/**
 * Vervolg ("makkelijk vergelijken tussen toestellen"): expliciete,
 * geïsoleerde verificatie van de vijf punten die vóór commit/push gecheckt
 * moesten worden, los van de zwaardere, echte-Excel-fixture-gebaseunde
 * `freshRepositoryRoundtrip.integration.test.ts` (die het volledige pad,
 * inclusief Excel-serialisatie, met de echte Lokeren-/Damme-bestanden dekt).
 */
describe("ImportService — makkelijk vergelijken tussen toestellen (sessie-reconstructie)", () => {
  let repository: InMemoryCountingRepository;
  let importService: ImportService;

  beforeEach(() => {
    repository = new InMemoryCountingRepository();
    importService = new ImportService(repository);
  });

  function makeHistoryEntry(overrides: Partial<StockHistoryEntry> = {}): StockHistoryEntry {
    return {
      countDate: "2026-09-30",
      sessionType: "MONTHLY",
      sessionName: "2026-09 Maand",
      articleId: "antwerpen:A1",
      articleNumber: "A1",
      description: "Artikel A1",
      totalCount: 8,
      previousCount: 5,
      differenceQuantity: 3,
      costPrice: 1,
      differenceAmount: 3,
      status: "GETELD",
      locationNames: ["Magazijn"],
      sourceSessionId: "orig-session-1",
      ...overrides,
    };
  }

  it("1. hetzelfde geëxporteerde bestand tweemaal importeren creëert nooit een dubbele telling", async () => {
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1")],
      "antwerpen-export.xlsx",
      [makeHistoryEntry()],
    );

    await importService.commitImport(await importService.prepareImport(source));
    const afterFirst = await repository.getSessionsForOffice("antwerpen");
    expect(afterFirst).toHaveLength(1);
    const firstId = afterFirst[0].id;

    // Exact hetzelfde bestand nogmaals importeren (zelfde StockSource-
    // instantie, zoals een gebruiker die per ongeluk tweemaal op "Importeer"
    // klikt, of hetzelfde mailattachment twee keer verwerkt).
    await importService.commitImport(await importService.prepareImport(source));
    const afterSecond = await repository.getSessionsForOffice("antwerpen");
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(firstId);
  });

  it("2. LEGACY_IMPORT-historiek wordt nooit als normale app-telling gereconstrueerd", async () => {
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A2")],
      "antwerpen-export.xlsx",
      [
        makeHistoryEntry({ articleId: "antwerpen:A1", articleNumber: "A1" }),
        makeHistoryEntry({
          articleId: "antwerpen:A2",
          articleNumber: "A2",
          sessionName: "LEGACY 31/03/2025",
          status: "LEGACY",
          source: "LEGACY_IMPORT",
          sourceSessionId: undefined,
        }),
      ],
    );
    await importService.commitImport(await importService.prepareImport(source));

    const sessions = await repository.getSessionsForOffice("antwerpen");
    expect(sessions).toHaveLength(1); // enkel de echte app-sessie, nooit de legacy periode.
    expect(sessions.some((s) => s.id === "LEGACY 31/03/2025")).toBe(false);

    const productCategoryService = new ProductCategoryService(repository);
    const comparisonService = new ComparisonService(repository, productCategoryService);
    const options = await comparisonService.getComparisonOptions("antwerpen");
    // De legacy periode blijft wél gewoon beschikbaar in "Vergelijken" — via
    // haar eigen, bestaande pad (provenance LEGACY_IMPORT), niet gedupliceerd
    // als een (foutieve) tweede APP_COUNT-optie.
    const legacyOption = options.sessions.find((o) => o.sessionName === "LEGACY 31/03/2025");
    expect(legacyOption?.provenance).toBe("LEGACY_IMPORT");
    expect(options.sessions.filter((o) => o.sessionName === "LEGACY 31/03/2025")).toHaveLength(1);
  });

  it("3. een echt geëxporteerde telling krijgt een stabiele identiteit over toestellen heen (geen heuristiek op naam/datum alleen)", async () => {
    const buildSource = () =>
      new FakeStockSource(
        makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
        [makeArticle("antwerpen", "A1")],
        "antwerpen-export.xlsx",
        [makeHistoryEntry({ sourceSessionId: "orig-session-42" })],
      );

    // Twee volledig onafhankelijke "toestellen" (repositories) importeren
    // elk, los van elkaar, exact hetzelfde geëxporteerde bestand.
    const repoDeviceX = new InMemoryCountingRepository();
    const importDeviceX = new ImportService(repoDeviceX);
    await importDeviceX.commitImport(await importDeviceX.prepareImport(buildSource()));

    const repoDeviceY = new InMemoryCountingRepository();
    const importDeviceY = new ImportService(repoDeviceY);
    await importDeviceY.commitImport(await importDeviceY.prepareImport(buildSource()));

    const sessionX = (await repoDeviceX.getSessionsForOffice("antwerpen"))[0];
    const sessionY = (await repoDeviceY.getSessionsForOffice("antwerpen"))[0];
    expect(sessionX.id).toBe("orig-session-42");
    expect(sessionY.id).toBe("orig-session-42");
    expect(sessionX.id).toBe(sessionY.id); // stabiele identiteit, niet enkel toevallig dezelfde naam/datum.
  });

  it("3b. ontbreekt sourceSessionId (ouder bestand), dan valt dit terug op een vers (maar idempotent, naam-gededupliceerd) id", async () => {
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1")],
      "antwerpen-export-oud-formaat.xlsx",
      [makeHistoryEntry({ sourceSessionId: undefined })],
    );
    await importService.commitImport(await importService.prepareImport(source));
    const firstId = (await repository.getSessionsForOffice("antwerpen"))[0].id;
    expect(firstId).not.toBe(""); // gewoon een gegenereerd id, geen lege/undefined-waarde.

    await importService.commitImport(await importService.prepareImport(source));
    const sessionsAfterSecond = await repository.getSessionsForOffice("antwerpen");
    expect(sessionsAfterSecond).toHaveLength(1); // nog steeds idempotent, via de sessienaam-heuristiek.
    expect(sessionsAfterSecond[0].id).toBe(firstId);
  });

  it("4. een gereconstrueerde telling mag als vorige fysieke baseline dienen, maar een ontbrekend artikel wordt nooit impliciet 0", async () => {
    // De gereconstrueerde telling kent enkel A1 (bv. omdat A2 toen nog niet
    // bestond, of omdat deze ene HISTORIE-regel om wat voor reden ontbrak) —
    // A2 zit bewust NERGENS in deze geïmporteerde historiek.
    const source = new FakeStockSource(
      makeOffice("antwerpen", "Antwerpen", ["Magazijn"]),
      [makeArticle("antwerpen", "A1"), makeArticle("antwerpen", "A2")],
      "antwerpen-export.xlsx",
      [makeHistoryEntry({ articleId: "antwerpen:A1", articleNumber: "A1" })],
    );
    await importService.commitImport(await importService.prepareImport(source));
    const reconstructed = (await repository.getSessionsForOffice("antwerpen"))[0];

    // Een ECHTE, nieuwe sessie op dit toestel telt zowel A1 als A2.
    const sessionService = new CountSessionService(repository);
    const countingService = new CountingService(repository);
    const nextSession = await sessionService.startSession("antwerpen", "MONTHLY");
    for (const articleId of nextSession.articleIds) {
      await countingService.recordCount({
        session: nextSession,
        articleId,
        locationId: "antwerpen:loc-1",
        quantity: 9,
      });
    }
    const officeForNextSession = await repository.getOffice("antwerpen");
    if (!officeForNextSession) throw new Error("kantoor 'antwerpen' niet gevonden");
    for (const location of officeForNextSession.locations.filter((l) => l.active)) {
      await countingService.completeLocation(nextSession.id, location.id);
    }
    await sessionService.completeSession(nextSession.id);

    const productCategoryService = new ProductCategoryService(repository);
    const comparisonService = new ComparisonService(repository, productCategoryService);
    const comparison = await comparisonService.compareSessions("antwerpen", reconstructed.id, nextSession.id);

    const a2Row = comparison.articles.find((r) => r.articleId === "antwerpen:A2");
    expect(a2Row).toBeDefined();
    // A2 ontbrak in de gereconstrueerde telling (A) — dat moet "onbekend",
    // NOOIT "voorraad 0" betekenen.
    expect(a2Row!.presentInA).toBe(false);
    expect(a2Row!.quantityA).toBeNull();
    expect(a2Row!.isNewArticle).toBe(true); // nooit een fictieve "isFromZero".
    expect(a2Row!.isFromZero).toBe(false);
    expect(a2Row!.quantityDifference).toBeNull(); // nooit stilzwijgend "9 - 0 = 9".

    // A1 (wél aanwezig in de reconstructie) dient wel gewoon als normale
    // vorige-telling-baseline.
    const a1Row = comparison.articles.find((r) => r.articleId === "antwerpen:A1");
    expect(a1Row!.presentInA).toBe(true);
    expect(a1Row!.quantityA).toBe(8); // de gereconstrueerde (bevroren) hoeveelheid van A1.

    // Ook Analyse zelf blijft gewoon werken op de gereconstrueerde sessie.
    const analysisService = new AnalysisService(repository, productCategoryService);
    const analysis = await analysisService.getSessionAnalysis(reconstructed.id);
    expect(analysis.kpis.articlesInScope).toBe(1); // enkel A1, A2 was hier nooit bekend.
  });
});
