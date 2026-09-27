import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { LocationAssignmentService } from "./LocationAssignmentService";
import { NewArticleService } from "./NewArticleService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { ProductCategoryService } from "./ProductCategoryService";
import { ActiveSessionExportError, CancelledSessionExportError, ExportService } from "./ExportService";
import { SessionNotEditableError } from "../errors";
import { InvalidQuantityError } from "../../domain/quantityValidation";
import type { ExportedFile, StockResultExportInput, StockResultExporter } from "../ports/StockResultExporter";
import type { Article, Office } from "../../domain/types";

/**
 * Data-integriteit-sprint (§1-§10): regressietests voor de nieuwe
 * hardeningsregels — sessie-onveranderlijkheid, exportblokkering,
 * finalisatie-bij-afronden (i.p.v. bij export), de vorige-fysieke-telling-
 * keten, bevroren locaties, en kwantiteitsvalidatie. Gebruikt bewust dezelfde
 * lichte `InMemoryCountingRepository`/`FakeExporter`-aanpak als
 * `sessionCancellation.integration.test.ts` — snel, geen IndexedDB nodig, en
 * test de ECHTE services (nooit de UI).
 */

class FakeExporter implements StockResultExporter {
  readonly calls: StockResultExportInput[] = [];

  async exportResults(input: StockResultExportInput): Promise<ExportedFile> {
    this.calls.push(input);
    return {
      fileName: "test.xlsx",
      data: new ArrayBuffer(0),
      newHistoricalSheet: input.frozenSnapshotRows
        ? undefined
        : { sheetName: input.snapshot.sessionName, rows: [["dummy"]] },
    };
  }
}

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "M1",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 5,
    sourceRow: 1,
    ...overrides,
  };
}

const office: Office = {
  id: "office-1",
  name: "Lokeren",
  baseDate: "2026-09-01",
  locations: [
    { id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true },
    { id: "office-1:loc-2", officeId: "office-1", number: 2, name: "Rek 2", active: true },
  ],
};

describe("Data-integriteit-sprint", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;
  let locationAssignmentService: LocationAssignmentService;
  let productCategoryService: ProductCategoryService;
  let newArticleService: NewArticleService;
  let exporter: FakeExporter;
  let exportService: ExportService;
  let groepCategoryId: string;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    locationAssignmentService = new LocationAssignmentService(repository);
    productCategoryService = new ProductCategoryService(repository);
    newArticleService = new NewArticleService(
      repository,
      locationAssignmentService,
      countingService,
      productCategoryService,
    );
    exporter = new FakeExporter();
    exportService = new ExportService(repository, exporter);
    await repository.saveOffice(office);
    await repository.saveArticles([makeArticle({ articleNumber: "M1" }), makeArticle({ articleNumber: "M2" })]);
    // De fixture-artikelen hebben al `productGroup: "GROEP"` -> de eenmalige
    // migratie (spec §4) bootstrapt hier automatisch al een "GROEP"-categorie;
    // deze hergebruiken i.p.v. een duplicaat aan te maken (DuplicateCategoryNameError).
    const categories = await productCategoryService.listCategories("office-1");
    groepCategoryId = categories.find((c) => c.name === "GROEP")!.id;
  });

  async function completeReadySession(): Promise<string> {
    const session = await sessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: "office-1:M1",
      locationId: "office-1:loc-1",
      quantity: 8,
    });
    await countingService.recordCount({
      session,
      articleId: "office-1:M2",
      locationId: "office-1:loc-1",
      quantity: 3,
    });
    await countingService.completeLocation(session.id, "office-1:loc-1");
    await countingService.completeLocation(session.id, "office-1:loc-2");
    await sessionService.completeSession(session.id);
    return session.id;
  }

  describe("§1: sessie-onveranderlijkheid (COMPLETED/CANCELLED = read-only snapshot)", () => {
    it("recordCount weigert op een COMPLETED sessie", async () => {
      const sessionId = await completeReadySession();
      const completed = await repository.getSession(sessionId);
      await expect(
        countingService.recordCount({
          session: completed!,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: 99,
        }),
      ).rejects.toThrow(SessionNotEditableError);
    });

    it("confirmAbsent/confirmAllAbsent weigeren op een COMPLETED sessie", async () => {
      const sessionId = await completeReadySession();
      const completed = (await repository.getSession(sessionId))!;
      await expect(countingService.confirmAbsent(completed, "office-1:M1")).rejects.toThrow(
        SessionNotEditableError,
      );
      await expect(countingService.confirmAllAbsent(completed, ["office-1:M1"])).rejects.toThrow(
        SessionNotEditableError,
      );
    });

    it("completeLocation/reopenLocation weigeren op een COMPLETED sessie", async () => {
      const sessionId = await completeReadySession();
      await expect(countingService.completeLocation(sessionId, "office-1:loc-1")).rejects.toThrow(
        SessionNotEditableError,
      );
      await expect(countingService.reopenLocation(sessionId, "office-1:loc-1")).rejects.toThrow(
        SessionNotEditableError,
      );
    });

    it("createArticleFoundDuringCounting weigert op een COMPLETED sessie, en laat geen wees-artikel achter", async () => {
      const sessionId = await completeReadySession();
      const completed = (await repository.getSession(sessionId))!;
      const articlesBefore = await repository.getArticles("office-1");

      await expect(
        newArticleService.createArticleFoundDuringCounting(completed, "office-1:loc-1", {
          description: "Gevonden na afronden",
          categoryId: groepCategoryId,
          unit: "stuk",
          countPeriod: "MONTHLY",
          quantity: 1,
        }),
      ).rejects.toThrow(SessionNotEditableError);

      // Geen enkel nieuw artikel mag ontstaan zijn — de guard staat VÓÓR elke schrijfactie.
      expect(await repository.getArticles("office-1")).toHaveLength(articlesBefore.length);
    });

    it("dezelfde schrijfacties weigeren ook op een CANCELLED sessie", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await sessionService.cancelSession(session.id);
      const cancelled = (await repository.getSession(session.id))!;

      await expect(
        countingService.recordCount({
          session: cancelled,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: 1,
        }),
      ).rejects.toThrow(SessionNotEditableError);
      await expect(countingService.completeLocation(session.id, "office-1:loc-1")).rejects.toThrow(
        SessionNotEditableError,
      );
    });

    it("een ACTIVE sessie blijft gewoon volledig bewerkbaar (geen regressie)", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await expect(
        countingService.recordCount({
          session,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: 8,
        }),
      ).resolves.toBeDefined();
      await expect(countingService.completeLocation(session.id, "office-1:loc-1")).resolves.toBeUndefined();
    });
  });

  describe("§2: officiële export enkel voor een COMPLETED sessie", () => {
    it("gooit ActiveSessionExportError voor een ACTIVE sessie en roept de exporter nooit aan", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await expect(exportService.exportSessionResults(session.id)).rejects.toThrow(
        ActiveSessionExportError,
      );
      expect(exporter.calls).toHaveLength(0);
    });

    it("gooit nog steeds CancelledSessionExportError voor een CANCELLED sessie (geen regressie)", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await sessionService.cancelSession(session.id);
      await expect(exportService.exportSessionResults(session.id)).rejects.toThrow(
        CancelledSessionExportError,
      );
    });

    it("exporteert normaal voor een COMPLETED sessie", async () => {
      const sessionId = await completeReadySession();
      const exported = await exportService.exportSessionResults(sessionId);
      expect(exported).toBeDefined();
      expect(exporter.calls).toHaveLength(1);
    });
  });

  describe("§3: finalisatie gebeurt bij 'Telling afronden', niet bij Excel-export", () => {
    it(
      "ESSENTIEEL: een sessie afronden ZONDER ooit te exporteren werkt Article.previousCount al bij — " +
        "een volgende sessie gebruikt meteen het correcte vorige fysieke aantal",
      async () => {
        await completeReadySession();
        // Bewust GEEN export hier — de essentie van deze test.
        expect(exporter.calls).toHaveLength(0);

        const articlesAfterCompletion = await repository.getArticles("office-1");
        expect(articlesAfterCompletion.find((a) => a.articleNumber === "M1")?.previousCount).toBe(8);
        expect(articlesAfterCompletion.find((a) => a.articleNumber === "M2")?.previousCount).toBe(3);

        // Een volgende sessie ziet dit meteen als vorige telling (via de
        // reviewberekening, die op Article.previousCount leunt).
        const nextSession = await sessionService.startSession("office-1", "MONTHLY");
        const review = await sessionService.getReview(nextSession.id);
        const m1Result = review.results.find((r) => r.articleId === "office-1:M1");
        expect(m1Result?.previousCount).toBe(8);
      },
    );

    it("HISTORIE en de bevroren snapshot bestaan al meteen na afronden, vóór enige export", async () => {
      const sessionId = await completeReadySession();
      const historyEntries = await repository.getStockHistoryEntries("office-1");
      expect(historyEntries.length).toBeGreaterThan(0);

      const finalized = await repository.getFinalizedSessionResult(sessionId);
      expect(finalized).toBeDefined();
      expect(finalized?.snapshot.articles.length).toBeGreaterThan(0);
    });

    it("een mislukte finalisatie laat de sessie gewoon ACTIVE (geen halfbijgewerkte staat)", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: "office-1:loc-1",
        quantity: 8,
      });
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: "office-1:loc-1",
        quantity: 3,
      });
      await countingService.completeLocation(session.id, "office-1:loc-1");
      await countingService.completeLocation(session.id, "office-1:loc-2");

      // Simuleer een falende repository-transactie.
      const originalFinalize = repository.finalizeSession.bind(repository);
      repository.finalizeSession = async () => {
        throw new Error("gesimuleerde opslagfout");
      };
      await expect(sessionService.completeSession(session.id)).rejects.toThrow("gesimuleerde opslagfout");
      repository.finalizeSession = originalFinalize;

      const stillActive = await repository.getSession(session.id);
      expect(stillActive?.status).toBe("ACTIVE");
      const articlesUnchanged = await repository.getArticles("office-1");
      expect(articlesUnchanged.find((a) => a.articleNumber === "M1")?.previousCount).toBe(5);
    });

    it("export van een COMPLETED sessie is PURE serialisatie: wijzigt Article.previousCount niet nogmaals", async () => {
      const sessionId = await completeReadySession();
      const articlesAfterCompletion = await repository.getArticles("office-1");
      const m1After = articlesAfterCompletion.find((a) => a.articleNumber === "M1")?.previousCount;
      expect(m1After).toBe(8);

      await exportService.exportSessionResults(sessionId);
      const articlesAfterExport = await repository.getArticles("office-1");
      expect(articlesAfterExport.find((a) => a.articleNumber === "M1")?.previousCount).toBe(8);
    });

    it("exporteren van dezelfde COMPLETED sessie meerdere keren geeft byte-voor-byte identieke resultaten, ook na een kostprijscorrectie nadien", async () => {
      const sessionId = await completeReadySession();
      const firstExport = await exportService.exportSessionResults(sessionId);

      // Een kostprijscorrectie op het artikel NA het afronden (bv. via het
      // Artikeldetailscherm) mag de reeds bevroren snapshot van deze sessie
      // nooit meer beïnvloeden.
      const articles = await repository.getArticles("office-1");
      await repository.saveArticles(
        articles.map((a) => (a.articleNumber === "M1" ? { ...a, costPrice: 999 } : a)),
      );

      const secondExport = await exportService.exportSessionResults(sessionId);
      expect(exporter.calls).toHaveLength(2);
      expect(exporter.calls[1].review).toEqual(exporter.calls[0].review);
      expect(exporter.calls[1].snapshot).toEqual(exporter.calls[0].snapshot);
      expect(secondExport.fileName).toBe(firstExport.fileName);
    });
  });

  describe("§5: bevroren session.locationIds", () => {
    it("een sessie bevriest de op dat moment actieve locaties bij het starten", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      expect(session.locationIds?.sort()).toEqual(["office-1:loc-1", "office-1:loc-2"]);
    });

    it("een locatie die pas NA sessiestart wordt toegevoegd, wordt niet plots verplicht voor deze sessie", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      const officeWithNewLocation = {
        ...office,
        locations: [
          ...office.locations,
          { id: "office-1:loc-3", officeId: "office-1", number: 3, name: "Rek 3", active: true },
        ],
      };
      await repository.saveOffice(officeWithNewLocation);

      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: "office-1:loc-1",
        quantity: 8,
      });
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: "office-1:loc-1",
        quantity: 3,
      });
      await countingService.completeLocation(session.id, "office-1:loc-1");
      await countingService.completeLocation(session.id, "office-1:loc-2");

      // Klaar om af te ronden ZONDER dat de nieuwe locatie 3 vereist wordt.
      await expect(sessionService.completeSession(session.id)).resolves.toBeUndefined();
    });

    it("een locatie die halverwege de sessie inactief gemaakt wordt, blijft verplicht om af te ronden", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      const officeWithLoc2Inactive = {
        ...office,
        locations: office.locations.map((l) =>
          l.id === "office-1:loc-2" ? { ...l, active: false } : l,
        ),
      };
      await repository.saveOffice(officeWithLoc2Inactive);

      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: "office-1:loc-1",
        quantity: 8,
      });
      await countingService.recordCount({
        session,
        articleId: "office-1:M2",
        locationId: "office-1:loc-1",
        quantity: 3,
      });
      await countingService.completeLocation(session.id, "office-1:loc-1");
      // loc-2 (nu inactief) NIET afgerond.

      const review = await sessionService.getReview(session.id);
      expect(review.allLocationsCompleted).toBe(false);
      expect(review.incompleteActiveLocations.map((l) => l.id)).toEqual(["office-1:loc-2"]);
    });
  });

  describe("§6: kwantiteitsvalidatie (negatief/NaN/Infinity geweigerd, 0/decimalen toegestaan)", () => {
    it("recordCount weigert een negatieve hoeveelheid", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await expect(
        countingService.recordCount({
          session,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: -1,
        }),
      ).rejects.toThrow(InvalidQuantityError);
    });

    it("recordCount weigert NaN en Infinity", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await expect(
        countingService.recordCount({
          session,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: Number.NaN,
        }),
      ).rejects.toThrow(InvalidQuantityError);
      await expect(
        countingService.recordCount({
          session,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: Infinity,
        }),
      ).rejects.toThrow(InvalidQuantityError);
    });

    it("recordCount aanvaardt 0 en decimalen", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await expect(
        countingService.recordCount({
          session,
          articleId: "office-1:M1",
          locationId: "office-1:loc-1",
          quantity: 0,
        }),
      ).resolves.toBeDefined();
      await expect(
        countingService.recordCount({
          session,
          articleId: "office-1:M2",
          locationId: "office-1:loc-1",
          quantity: 2.5,
        }),
      ).resolves.toBeDefined();
    });

    it("createArticleFoundDuringCounting weigert een ongeldige hoeveelheid vóór enige schrijfactie", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      const articlesBefore = await repository.getArticles("office-1");
      await expect(
        newArticleService.createArticleFoundDuringCounting(session, "office-1:loc-1", {
          description: "Nieuw gevonden",
          categoryId: groepCategoryId,
          unit: "stuk",
          countPeriod: "MONTHLY",
          quantity: -3,
        }),
      ).rejects.toThrow(InvalidQuantityError);
      expect(await repository.getArticles("office-1")).toHaveLength(articlesBefore.length);
    });
  });

  describe("§8: 'Afronden met openstaande artikels' blijft intact na de refactor", () => {
    it("niet-getelde scope-artikelen krijgen OVERGENOMEN - NIET GETELD, geen fake entry, previousCount ongemoeid", async () => {
      const session = await sessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session,
        articleId: "office-1:M1",
        locationId: "office-1:loc-1",
        quantity: 8,
      });
      // M2 blijft bewust ongeteld.
      await sessionService.completeSessionWithOutstandingArticles(session.id);

      const finalized = await repository.getFinalizedSessionResult(session.id);
      const m2Snapshot = finalized?.snapshot.articles.find((a) => a.articleId === "office-1:M2");
      expect(m2Snapshot?.status).toBe("OVERGENOMEN - NIET GETELD");

      const entries = await repository.getCountEntries(session.id);
      expect(entries.some((e) => e.articleId === "office-1:M2")).toBe(false);

      const articlesAfter = await repository.getArticles("office-1");
      expect(articlesAfter.find((a) => a.articleNumber === "M2")?.previousCount).toBe(5); // ongewijzigd
      expect(articlesAfter.find((a) => a.articleNumber === "M1")?.previousCount).toBe(8); // wel bijgewerkt
    });
  });
});
