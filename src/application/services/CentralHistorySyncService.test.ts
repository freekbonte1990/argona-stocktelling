import { beforeEach, describe, expect, it } from "vitest";
import { CentralHistoryError } from "../ports/CentralHistorySource";
import { CentralHistorySyncService } from "./CentralHistorySyncService";
import { CountSessionService, CentralSessionDeletionNotAllowedError } from "./CountSessionService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { AnalysisService } from "./AnalysisService";
import { ProductCategoryService } from "./ProductCategoryService";
import {
  FakeCentralHistorySource,
  makeArticle,
  makeEntry,
  makeFile,
  makeOffice,
  offline,
} from "./centralHistoryTestUtils";

const AUG = (articleNumber: string, overrides = {}) =>
  makeEntry({ articleId: `damme:${articleNumber}`, articleNumber, description: `Artikel ${articleNumber}`, ...overrides });

describe("CentralHistorySyncService", () => {
  let repository: InMemoryCountingRepository;
  let source: FakeCentralHistorySource;
  let service: CentralHistorySyncService;
  let nowMs: number;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    await repository.saveOffice(makeOffice());
    await repository.saveArticles([makeArticle("damme", "A1"), makeArticle("damme", "A2")]);
    source = new FakeCentralHistorySource(
      makeFile([AUG("A1"), AUG("A2", { totalCount: 3, previousCount: 3, differenceQuantity: 0, differenceAmount: 0 })]),
    );
    nowMs = Date.parse("2026-10-02T08:00:00.000Z");
    service = new CentralHistorySyncService(repository, source, { now: () => new Date(nowMs) });
  });

  describe("nieuw toestel: centrale historiek → echte, afgeronde sessies", () => {
    it("maakt een COMPLETED sessie met stabiele id + FinalizedSessionResult, en bewaart de HISTORIE", async () => {
      const result = await service.syncOffice("damme");
      expect(result).toMatchObject({ outcome: "synced", addedSessionCount: 1 });

      const sessions = await repository.getSessionsForOffice("damme");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: "session-aug", status: "COMPLETED", type: "MONTHLY" });
      expect(await repository.getFinalizedSessionResult("session-aug")).toBeDefined();
      expect(await repository.getStockHistoryEntries("damme")).toHaveLength(2);
    });

    it("Analyse werkt meteen op de gesynchroniseerde sessie (aantallen en kostprijzen exact)", async () => {
      await service.syncOffice("damme");
      const analysis = await new AnalysisService(
        repository,
        new ProductCategoryService(repository),
      ).getSessionAnalysis("session-aug");
      expect(analysis).toBeDefined();
      const result = await repository.getFinalizedSessionResult("session-aug");
      const a1 = result!.snapshot.articles.find((a) => a.articleId === "damme:A1");
      expect(a1).toMatchObject({ totalCount: 10, costPrice: 2, amount: 20, differenceQuantity: 6 });
    });
  });

  describe("sync is additief en idempotent (eis 4)", () => {
    it("herhaalde sync maakt geen dubbels", async () => {
      await service.syncOffice("damme", { force: true });
      const second = await service.syncOffice("damme", { force: true });
      expect(second.addedSessionCount).toBe(0);
      expect(await repository.getSessionsForOffice("damme")).toHaveLength(1);
      expect(await repository.getStockHistoryEntries("damme")).toHaveLength(2);
    });

    it("verwijdert nooit een lokale sessie omdat ze niet centraal staat", async () => {
      await service.syncOffice("damme");
      // Lokaal eigen afgeronde sessie, onbekend voor de centrale bron:
      await repository.finalizeSession({
        session: {
          id: "local-only",
          officeId: "damme",
          type: "MONTHLY",
          status: "COMPLETED",
          startedAt: "2026-09-30T10:00:00.000Z",
          completedAt: "2026-09-30T10:00:00.000Z",
          sourceFileName: "x",
          sourceBaseDate: null,
          articleIds: [],
        },
        updatedArticles: [],
        historyEntries: [makeEntry({ countDate: "2026-09-30", sessionName: "2026-09 Maand", sourceSessionId: "local-only" })],
        review: (await repository.getFinalizedSessionResult("session-aug"))!.review,
        snapshot: (await repository.getFinalizedSessionResult("session-aug"))!.snapshot,
      });
      await service.syncOffice("damme", { force: true });
      expect((await repository.getSessionsForOffice("damme")).map((s) => s.id).sort()).toEqual(["local-only", "session-aug"]);
    });

    it("afwezig in het centrale bestand betekent nooit verwijderen — ook niet als het bestand leeg wordt", async () => {
      await service.syncOffice("damme");
      source.set(makeFile([]));
      await service.syncOffice("damme", { force: true });
      expect(await repository.getSessionsForOffice("damme")).toHaveLength(1);
      expect(await repository.getStockHistoryEntries("damme")).toHaveLength(2);
    });

    it("tombstones (deletedSessionIds) worden in v1 NIET toegepast", async () => {
      await service.syncOffice("damme");
      source.set(makeFile([AUG("A1")], { deletedSessionIds: ["session-aug"] }));
      await service.syncOffice("damme", { force: true });
      expect(await repository.getSession("session-aug")).toBeDefined();
      expect(await repository.getStockHistoryEntries("damme")).toHaveLength(2);
    });

    it("overschrijft nooit lokale data: bij een botsing op (sessienaam, artikel) wint de lokale regel", async () => {
      await repository.saveStockHistoryEntries("damme", [AUG("A1", { totalCount: 99, differenceQuantity: 95, differenceAmount: 190 })]);
      await service.syncOffice("damme");
      const a1 = (await repository.getStockHistoryEntries("damme")).find((e) => e.articleId === "damme:A1");
      expect(a1?.totalCount).toBe(99);
    });

    it("een centrale sessie die lokaal al op id bestaat wordt niet opnieuw aangemaakt of gewijzigd", async () => {
      await service.syncOffice("damme");
      const before = await repository.getSession("session-aug");
      source.set(makeFile([AUG("A1"), AUG("A2"), AUG("A1", { sessionName: "2026-09 Maand", countDate: "2026-09-30", sourceSessionId: "session-sep" })]));
      const result = await service.syncOffice("damme", { force: true });
      expect(result.addedSessionCount).toBe(1);
      expect(await repository.getSession("session-aug")).toEqual(before);
      expect(await repository.getSessionsForOffice("damme")).toHaveLength(2);
    });

    it("legacy-periodes komen in de historiek maar worden nooit als CountSession gereconstrueerd", async () => {
      source.set(
        makeFile([
          AUG("A1"),
          AUG("A1", { source: "LEGACY_IMPORT", status: "LEGACY", sessionType: "FULL", sessionName: "LEGACY 31/03/2026", countDate: "2026-03-31", sourceSessionId: undefined, previousCount: null, differenceQuantity: null, differenceAmount: null }),
        ]),
      );
      await service.syncOffice("damme");
      expect(await repository.getSessionsForOffice("damme")).toHaveLength(1);
      expect((await repository.getStockHistoryEntries("damme")).some((e) => e.source === "LEGACY_IMPORT")).toBe(true);
    });

    it("onbekende artikelen krijgen een historisch/inactief record — nooit een bestaand artikel overschreven", async () => {
      source.set(makeFile([AUG("A1"), AUG("GONE", { description: "Verdwenen artikel" })]));
      await service.syncOffice("damme");
      const articles = await repository.getArticles("damme");
      const gone = articles.find((a) => a.id === "damme:GONE");
      expect(gone).toMatchObject({ assortmentActive: false, status: "INACTIVE", description: "Verdwenen artikel" });
      expect(articles.find((a) => a.id === "damme:A1")).toMatchObject({ costPrice: 2, status: "ACTIVE" });
      const result = await repository.getFinalizedSessionResult("session-aug");
      expect(result!.snapshot.articles.map((a) => a.articleId)).toContain("damme:GONE");
    });
  });

  describe("falen blokkeert nooit (eis 5/6/7)", () => {
    it.each([
      ["unavailable", "niet bereikbaar"],
      ["invalid", "onbruikbaar"],
    ] as const)("een %s-fout gooit niet, laat lokale data ongemoeid en wordt een discrete melding", async (kind, text) => {
      await service.syncOffice("damme");
      const sessionsBefore = await repository.getSessionsForOffice("damme");
      source.set(new CentralHistoryError(kind, "detail"));
      const result = await service.syncOffice("damme", { force: true });
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain(text);
      expect(await repository.getSessionsForOffice("damme")).toEqual(sessionsBefore);
      const status = await repository.getCentralHistoryStatus("damme");
      expect(status?.lastError).toContain(text);
      // Laatste SUCCES blijft bewaard:
      expect(status?.lastSuccessAt).toBe("2026-10-02T08:00:00.000Z");
      expect(status?.centralSessionIds).toContain("session-aug");
    });

    it("een onverwachte fout (geen CentralHistoryError) wordt ook afgevangen", async () => {
      source.set(new TypeError("boom"));
      const result = await service.syncOffice("damme");
      expect(result.outcome).toBe("failed");
    });

    it("een kapotte repository-schrijfactie wordt afgevangen en gooit nooit", async () => {
      repository.saveStockHistoryEntries = async () => {
        throw new Error("schijf vol");
      };
      const result = await service.syncOffice("damme");
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain("schijf vol");
    });

    it("offline na één succesvolle sync: alle data en Analyse blijven werken", async () => {
      await service.syncOffice("damme");
      source.set(offline());
      expect((await service.syncOffice("damme", { force: true })).outcome).toBe("failed");
      const analysis = await new AnalysisService(repository, new ProductCategoryService(repository)).getSessionAnalysis("session-aug");
      expect(analysis).toBeDefined();
    });

    it("niets gepubliceerd (not-found): geen fout, wel een discrete melding", async () => {
      source.set(new CentralHistoryError("not-found", "404"));
      const result = await service.syncOffice("damme");
      expect(result.message).toContain("nog geen centrale historiek");
      expect((await repository.getCentralHistoryStatus("damme"))?.lastSuccessAt).not.toBeNull();
    });

    it("een kantoor dat lokaal niet bestaat wordt niet gesynchroniseerd", async () => {
      expect((await service.syncOffice("lokeren")).outcome).toBe("no-office");
      expect(source.calls).toBe(0);
    });
  });

  describe("status, drempel en gelijktijdigheid", () => {
    it("bewaart laatste succes, generatedAt en aantal toegevoegde sessies", async () => {
      await service.syncOffice("damme");
      expect(await repository.getCentralHistoryStatus("damme")).toMatchObject({
        lastSuccessAt: "2026-10-02T08:00:00.000Z",
        lastGeneratedAt: "2026-10-01T12:00:00.000Z",
        lastError: null,
        lastAddedSessionCount: 1,
        centralSessionIds: ["session-aug"],
        centralSessionNames: ["2026-08 Maand"],
      });
    });

    it("slaat een nieuwe poging over na een recent succes, tenzij force", async () => {
      await service.syncOffice("damme");
      nowMs += 60_000;
      expect((await service.syncOffice("damme")).outcome).toBe("skipped-recent");
      expect(source.calls).toBe(1);
      expect((await service.syncOffice("damme", { force: true })).outcome).toBe("synced");
      expect(source.calls).toBe(2);
      nowMs += 11 * 60_000;
      expect((await service.syncOffice("damme")).outcome).toBe("synced");
    });

    it("gelijktijdige aanroepen voor hetzelfde kantoor delen één fetch (geen race → geen dubbels)", async () => {
      const [a, b] = await Promise.all([service.syncOffice("damme"), service.syncOffice("damme")]);
      expect(source.calls).toBe(1);
      expect(a).toBe(b);
      expect(await repository.getSessionsForOffice("damme")).toHaveLength(1);
    });
  });

  describe("centrale sessies zijn read-only qua verwijdering (aanpassing 3)", () => {
    it("deleteSession weigert een centrale sessie en laat alles ongemoeid", async () => {
      await service.syncOffice("damme");
      const sessionService = new CountSessionService(repository);
      await expect(sessionService.deleteSession("session-aug")).rejects.toBeInstanceOf(CentralSessionDeletionNotAllowedError);
      expect(await repository.getSession("session-aug")).toBeDefined();
      expect(await repository.getStockHistoryEntries("damme")).toHaveLength(2);
    });

    it("beschermt ook een lokale sessie die enkel op NAAM overeenkomt met een centrale sessie", async () => {
      await service.syncOffice("damme");
      await repository.createSession({
        id: "local-same-period",
        officeId: "damme",
        type: "MONTHLY",
        status: "COMPLETED",
        startedAt: "2026-08-31T10:00:00.000Z",
        completedAt: "2026-08-31T10:00:00.000Z",
        sourceFileName: "x",
        sourceBaseDate: null,
        articleIds: [],
      });
      await expect(new CountSessionService(repository).deleteSession("local-same-period")).rejects.toBeInstanceOf(
        CentralSessionDeletionNotAllowedError,
      );
    });

    it("een louter lokale sessie blijft gewoon verwijderbaar", async () => {
      await service.syncOffice("damme");
      await repository.createSession({
        id: "local-july",
        officeId: "damme",
        type: "MONTHLY",
        status: "COMPLETED",
        startedAt: "2026-07-31T10:00:00.000Z",
        completedAt: "2026-07-31T10:00:00.000Z",
        sourceFileName: "x",
        sourceBaseDate: null,
        articleIds: [],
      });
      await new CountSessionService(repository).deleteSession("local-july");
      expect(await repository.getSession("local-july")).toBeUndefined();
    });
  });
});
