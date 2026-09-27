import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { LocationAssignmentService } from "./LocationAssignmentService";
import { NewArticleService } from "./NewArticleService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { ProductCategoryService } from "./ProductCategoryService";
import { computeSessionReview } from "../../domain/review";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * v0.2.1 correctieronde §3: nieuwe artikelen aanmaken, zowel vanuit
 * Artikels (3A) als vanuit een lopende telling (3B) — via de orchestratielaag,
 * bovenop InMemoryCountingRepository (zelfde patroon als
 * LocationAssignmentService.test.ts).
 */

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return {
    id: `office-1:${articleNumber}`,
    officeId: "office-1",
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
    ...overrides,
  };
}

const office: Office = {
  id: "office-1",
  name: "Damme",
  baseDate: null,
  locations: [1, 2].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n,
    name: `Rek ${n}`,
    active: true,
  })),
};

const antwerpenOffice: Office = {
  id: "office-2",
  name: "Antwerpen",
  baseDate: null,
  locations: [{ id: "office-2:loc-1", officeId: "office-2", number: 1, name: "Rek 1", active: true }],
};

describe("NewArticleService", () => {
  let repository: InMemoryCountingRepository;
  let locationAssignmentService: LocationAssignmentService;
  let countingService: CountingService;
  let productCategoryService: ProductCategoryService;
  let newArticleService: NewArticleService;
  let session: CountSession;
  /** Sprint 3.2 §10: "Productgroep" (vrije tekst) is vervangen door een verplichte `categoryId` — deze test-categorie staat model voor de vroegere vrije-tekst "Groep". */
  let groepCategoryId: string;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    locationAssignmentService = new LocationAssignmentService(repository);
    countingService = new CountingService(repository);
    productCategoryService = new ProductCategoryService(repository);
    newArticleService = new NewArticleService(repository, locationAssignmentService, countingService, productCategoryService);
    const sessionService = new CountSessionService(repository);
    await repository.saveOffice(office);
    await repository.saveOffice(antwerpenOffice);
    await repository.saveArticles([makeArticle("A1")]);
    session = await sessionService.startSession("office-1", "MONTHLY");
    // A1 heeft al `productGroup: "GROEP"` -> de eenmalige migratie (spec §4)
    // bootstrapt hier automatisch al een "GROEP"-categorie; deze hergebruiken
    // i.p.v. een (case-insensitief botsend) duplicaat "Groep" aan te maken.
    const categories = await productCategoryService.listCategories("office-1");
    groepCategoryId = categories.find((c) => c.name === "GROEP")!.id;
  });

  describe("createArticle (3A, vanuit Artikels)", () => {
    it("krijgt een tijdelijk artikelnummer volgens de bestaande conventie, en idType TIJDELIJK", async () => {
      // `addCategory` geeft de VOLLEDIGE lijst terug (incl. de reeds
      // gemigreerde "GROEP"-categorie) — expliciet op naam opzoeken.
      const bevestiging = (await productCategoryService.addCategory("office-1", "Bevestiging")).find(
        (c) => c.name === "Bevestiging",
      )!;
      const article = await newArticleService.createArticle("office-1", {
        description: "Nieuwe schroef",
        categoryId: bevestiging.id,
        unit: "stuk",
        countPeriod: "MONTHLY",
      });
      expect(article.articleNumber).toBe("TMP-DAM-0001");
      expect(article.idType).toBe("TIJDELIJK");
      expect(article.officialArticleNumber).toBeNull();
      expect(article.status).toBe("ACTIVE");
      expect(article.id).toBe("office-1:TMP-DAM-0001");
      // Sprint 3.2 §10: de naam van het gekozen productgamma dient meteen als bronproductgroep.
      expect(article.productGroup).toBe("Bevestiging");
      expect(article.categoryId).toBe(bevestiging.id);

      const stored = await repository.getArticles("office-1");
      expect(stored.some((a) => a.id === article.id)).toBe(true);
    });

    it("hergebruikt geen reeds bestaand tijdelijk nummer (opeenvolgende aanroepen)", async () => {
      const first = await newArticleService.createArticle("office-1", {
        description: "Eerste",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
      });
      const second = await newArticleService.createArticle("office-1", {
        description: "Tweede",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
      });
      expect(first.articleNumber).toBe("TMP-DAM-0001");
      expect(second.articleNumber).toBe("TMP-DAM-0002");
    });

    it("kan meteen aan meerdere stocklocaties gekoppeld worden", async () => {
      const article = await newArticleService.createArticle("office-1", {
        description: "Multi-locatie artikel",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
        locationIds: ["office-1:loc-1", "office-1:loc-2"],
      });
      const assignments = await repository.getArticleLocationAssignments("office-1");
      const active = assignments.filter((a) => a.articleId === article.id && a.active);
      expect(active.map((a) => a.locationId).sort()).toEqual(["office-1:loc-1", "office-1:loc-2"]);
    });

    it("een lege categoryId wordt geweigerd", async () => {
      await expect(
        newArticleService.createArticle("office-1", {
          description: "Zonder productgamma",
          categoryId: "  ",
          unit: "stuk",
          countPeriod: "MONTHLY",
        }),
      ).rejects.toThrow(/[Pp]roductgamma/);
    });

    it("Antwerpen en Damme blijven apart genummerd (multi-office)", async () => {
      const [antwerpenGroep] = await productCategoryService.listCategories("office-2");
      const dammeArticle = await newArticleService.createArticle("office-1", {
        description: "Damme artikel",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
      });
      const antwerpenArticle = await newArticleService.createArticle("office-2", {
        description: "Antwerpen artikel",
        categoryId: antwerpenGroep.id,
        unit: "stuk",
        countPeriod: "MONTHLY",
      });
      expect(dammeArticle.articleNumber).toBe("TMP-DAM-0001");
      expect(antwerpenArticle.articleNumber).toBe("TMP-ANT-0001");
    });
  });

  describe("createArticleFoundDuringCounting (3B, vanuit een lopende telling)", () => {
    it("maakt artikel + locatiekoppeling + CountEntry aan, en het verschijnt meteen in Review", async () => {
      const article = await newArticleService.createArticleFoundDuringCounting(session, "office-1:loc-1", {
        description: "Onverwacht gevonden onderdeel",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
        quantity: 3,
      });

      const assignments = await repository.getArticleLocationAssignments("office-1");
      expect(
        assignments.some(
          (a) => a.articleId === article.id && a.locationId === "office-1:loc-1" && a.active,
        ),
      ).toBe(true);

      const entries = await repository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === article.id);
      expect(entry).toBeDefined();
      expect(entry?.quantity).toBe(3);
      expect(entry?.counted).toBe(true);

      const allArticles = await repository.getArticles("office-1");
      const review = computeSessionReview(session, allArticles, office.locations, entries);
      const result = review.results.find((r) => r.articleId === article.id);
      expect(result).toBeDefined();
      expect(result?.isManualAddition).toBe(true);
      expect(result?.flaggedForControl).toBe(true);
    });

    it("een expliciete hoeveelheid 0 is geldig", async () => {
      const article = await newArticleService.createArticleFoundDuringCounting(session, "office-1:loc-1", {
        description: "Leeg gevonden",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
        quantity: 0,
      });
      const entries = await repository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === article.id);
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(0);
    });

    it("de huidige locatie wordt automatisch gebruikt, geen andere", async () => {
      const article = await newArticleService.createArticleFoundDuringCounting(session, "office-1:loc-2", {
        description: "Op Rek 2 gevonden",
        categoryId: groepCategoryId,
        unit: "stuk",
        countPeriod: "MONTHLY",
        quantity: 5,
      });
      const assignments = await repository.getArticleLocationAssignments("office-1");
      const active = assignments.filter((a) => a.articleId === article.id && a.active);
      expect(active.map((a) => a.locationId)).toEqual(["office-1:loc-2"]);
    });
  });
});
