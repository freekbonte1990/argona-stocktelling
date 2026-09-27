import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";
import { parseLegacyStockDamme, parseLegacyStockLokeren } from "./parseLegacyStock";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { ImportService } from "../../application/services/ImportService";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import { ExportService } from "../../application/services/ExportService";
import { LegacyImportService } from "../../application/services/LegacyImportService";
import { AnalysisService } from "../../application/services/AnalysisService";
import { ComparisonService } from "../../application/services/ComparisonService";
import { ProductCategoryService } from "../../application/services/ProductCategoryService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import type { CountSession } from "../../domain/types";

/**
 * Sprint 3.3 §7 ("Monday rehearsal"): de volledige, end-to-end generale
 * repetitie voor maandagochtend, met de ECHTE, door Argona aangeleverde
 * data — niet enkel gefabriceerde testrijen (zie `LegacyImportService.test.ts`/
 * `freshRepositoryRoundtrip.integration.test.ts` voor die, gerichte varianten).
 *
 * Dekt in één doorlopend scenario, in exact deze volgorde (spec §7):
 *   1. Lege repository -> importeer het huidige, actuele masterbestand;
 *   2. -> importeer de legacy-historiek (echt TGOVL-bestand, Lokeren);
 *   3. verifieer dat de historische analyse er meteen is (HISTORIE-regels,
 *      status LEGACY/source LEGACY_IMPORT, alle 7 periodes);
 *   4. verifieer dat oude/inactieve (legacy-only) artikelen buiten de scope
 *      van een NIEUWE telling vallen (centralized count-scope-regel, §2);
 *   5. nieuwe telling -> afronden;
 *   6. Analyse openen (AnalysisService) — moet gewoon werken, ONGEACHT de
 *      aanwezige legacy-historiek;
 *   7. een TWEEDE telling -> afronden -> Vergelijking t.o.v. de vorige
 *      betrouwbare telling (ComparisonService) — moet ook gewoon werken;
 *   7b. Sprint 3.3 §1: de tweede telling kan ONMIDDELLIJK ook vergeleken
 *      worden met de betrouwbare legacy-snapshot van 01/09/2026 — zonder
 *      ooit een legacy periode als fake CountSession te modelleren;
 *   8. exporteren;
 *   9. importeren in een TWEEDE, volledig lege repository -> verifieer dat
 *      alles (incl. de legacy-historiek/-artikelen) overleeft, en dat een
 *      nieuwe telling daar de count-scope-regel nog steeds correct toepast,
 *      EN dat dezelfde legacy-vs-nieuwe-telling vergelijking daar ook werkt.
 *
 * Sprint 3.3 §1 (bijwerking van de eerder gerapporteerde scopebeperking):
 * Analyse/Vergelijking accepteerden vóór deze sprint uitsluitend ECHTE
 * `CountSession`s met een bevroren `FinalizedSessionResult`. Sinds Sprint
 * 3.3 §1 kan Vergelijken OOK een legacy geïmporteerde periode als A en/of B
 * gebruiken (via een gesynthetiseerde `StockSnapshot`, zie
 * `domain/stockSnapshot.ts#buildLegacyPeriodSnapshot`) — nog steeds ZONDER
 * een legacy periode als `CountSession` te modelleren (geen sessie, geen
 * locaties, geen volledigheid/session-review — enkel de reeds bevroren
 * HISTORIE-regels). Dit scenario dekt daarom nu zowel de "twee echte
 * tellingen"-vergelijking als de "legacy vs. nieuwe telling"-vergelijking.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../test-fixtures");
const LEGACY_FIXTURES_DIR = path.join(FIXTURES_DIR, "legacy");
const LOKEREN_LEGACY_FILE = "TGOVL - Stock 01.09.2026 - Telfrequentie.xlsx";

function loadBuffer(filePath: string): ArrayBuffer {
  const nodeBuffer = fs.readFileSync(filePath);
  return nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength) as ArrayBuffer;
}

function makeDevice() {
  const repository = new InMemoryCountingRepository();
  const productCategoryService = new ProductCategoryService(repository);
  return {
    repository,
    importService: new ImportService(repository),
    sessionService: new CountSessionService(repository),
    countingService: new CountingService(repository),
    exportService: new ExportService(repository, new ExcelStockResultExporter()),
    legacyImportService: new LegacyImportService(repository),
    analysisService: new AnalysisService(repository, productCategoryService),
    comparisonService: new ComparisonService(repository, productCategoryService),
  };
}

/** Telt de volledige sessiescope op de eenvoudigst mogelijke, deterministische manier af: elk verwacht artikel op locatie 1, met dezelfde hoeveelheid als de vorige telling (geen verschil nodig voor dit scenario). */
async function countEntireSessionUnchanged(
  device: ReturnType<typeof makeDevice>,
  officeId: string,
  session: CountSession,
) {
  const articles = await device.repository.getArticles(officeId);
  const articleById = new Map(articles.map((a) => [a.id, a]));
  for (const articleId of session.articleIds) {
    const article = articleById.get(articleId);
    if (!article) throw new Error(`artikel ${articleId} niet gevonden`);
    await device.countingService.recordCount({
      session,
      articleId,
      locationId: `${officeId}:loc-1`,
      quantity: article.previousCount ?? 0,
    });
  }
  const office = await device.repository.getOffice(officeId);
  if (!office) throw new Error(`kantoor ${officeId} niet gevonden`);
  for (const location of office.locations.filter((l) => l.active)) {
    await device.countingService.completeLocation(session.id, location.id);
  }
  await device.sessionService.completeSession(session.id);
}

const hasLegacyFixture = fs.existsSync(path.join(LEGACY_FIXTURES_DIR, LOKEREN_LEGACY_FILE));
const maybeIt = hasLegacyFixture ? it : it.skip;

describe("Monday rehearsal (Sprint 3.3 §7 — end-to-end, met echte data)", () => {
  maybeIt(
    "actueel masterbestand + echte legacy-historiek -> nieuwe telling -> analyse -> vergelijking -> export -> herimport op een tweede lege repository, alles overleeft",
    async () => {
      // ---- 1. Repository A: lege repository, importeer het huidige masterbestand ----
      const deviceA = makeDevice();
      const masterBuffer = loadBuffer(path.join(FIXTURES_DIR, "Stocktelling_Lokeren_standaard.xlsx"));
      const sourceA = createExcelStockSourceFromBuffer(masterBuffer, "Stocktelling_Lokeren_standaard.xlsx");
      await deviceA.importService.commitImport(await deviceA.importService.prepareImport(sourceA));

      const articlesBeforeLegacy = await deviceA.repository.getArticles("lokeren");
      expect(articlesBeforeLegacy.length).toBeGreaterThan(0);

      // ---- 2. Importeer de ECHTE legacy-historiek (TGOVL, Lokeren) ----
      const legacyBuffer = loadBuffer(path.join(LEGACY_FIXTURES_DIR, LOKEREN_LEGACY_FILE));
      const legacyRows = parseLegacyStockLokeren(legacyBuffer, LOKEREN_LEGACY_FILE);
      const legacyResult = await deviceA.legacyImportService.commit("lokeren", legacyRows);
      // De echte TGOVL-data bevat een handvol brondata-rijen die, binnen
      // dezelfde periode, naar hetzelfde artikel resolveren (zie
      // `LegacyImportPreview.duplicateRowCount`, ontdekt via dit end-to-end-
      // scenario) — de effectief bewaarde HISTORIE-telling ligt daardoor
      // terecht iets lager dan het ruwe aantal brondata-rijen, nooit hoger.
      expect(legacyResult.preview.duplicateRowCount).toBeGreaterThanOrEqual(0);
      expect(legacyResult.historyEntryCount).toBe(legacyRows.length - legacyResult.preview.duplicateRowCount);

      // ---- 3. Historische analyse is er meteen, correct gelabeld ----
      const historyAfterLegacy = await deviceA.repository.getStockHistoryEntries("lokeren");
      const legacyEntries = historyAfterLegacy.filter((e) => e.status === "LEGACY");
      expect(legacyEntries.length).toBe(legacyResult.historyEntryCount);
      expect(legacyEntries.every((e) => e.source === "LEGACY_IMPORT")).toBe(true);
      // Alle 7 vereiste periodes zijn aanwezig als aparte, herkenbare "LEGACY ..."-tellingnamen.
      const legacySessionNames = new Set(legacyEntries.map((e) => e.sessionName));
      expect(legacySessionNames.size).toBe(7);
      for (const name of legacySessionNames) {
        expect(name.startsWith("LEGACY ")).toBe(true);
      }
      // Geen enkele legacy-regel fabriceert een fictieve "vorige telling"/
      // verschil — dat blijft altijd onbekend voor een legacy-punt (spec §4).
      expect(legacyEntries.every((e) => e.previousCount === null && e.differenceQuantity === null)).toBe(true);

      // ---- 4. Oude/inactieve (legacy-only) artikelen vallen buiten de scope van een NIEUWE telling ----
      const articlesAfterLegacy = await deviceA.repository.getArticles("lokeren");
      const legacyOnlyArticles = articlesAfterLegacy.filter((a) => a.assortmentActive === false);
      // De echte TGOVL-data bevat gekende, niet meer in het huidige masterbestand
      // voorkomende artikelnummers (zie de eerdere data-analyse) — dit moet dus
      // effectief minstens 1 nieuw, historisch/inactief artikel opgeleverd hebben.
      expect(legacyOnlyArticles.length).toBeGreaterThan(0);
      expect(legacyOnlyArticles.every((a) => a.status === "INACTIVE")).toBe(true);

      const session1 = await deviceA.sessionService.startSession("lokeren", "MONTHLY");
      expect(session1.articleIds.length).toBeGreaterThan(0);
      for (const legacyOnly of legacyOnlyArticles) {
        expect(session1.articleIds).not.toContain(legacyOnly.id);
      }

      // ---- 5. Eerste telling volledig (ongewijzigd) afronden ----
      await countEntireSessionUnchanged(deviceA, "lokeren", session1);

      // ---- 6. Analyse openen — moet gewoon werken, ongeacht de legacy-historiek ----
      const analysis1 = await deviceA.analysisService.getSessionAnalysis(session1.id);
      expect(analysis1.header.sessionId).toBe(session1.id);
      expect(analysis1.articles.length).toBeGreaterThan(0);

      // ---- 7. Tweede telling -> afronden -> vergelijken t.o.v. de vorige betrouwbare telling ----
      const session2 = await deviceA.sessionService.startSession("lokeren", "MONTHLY");
      await countEntireSessionUnchanged(deviceA, "lokeren", session2);

      const defaultSelection = await deviceA.comparisonService.getDefaultSelection("lokeren", session2.id);
      expect(defaultSelection.sessionIdA).toBe(session1.id);
      expect(defaultSelection.sessionIdB).toBe(session2.id);

      const comparison = await deviceA.comparisonService.compareSessions("lokeren", session1.id, session2.id);
      expect(comparison.articles.length).toBeGreaterThan(0);

      // ---- 7b. Sprint 3.3 §1: de nieuwe telling kan ONMIDDELLIJK vergeleken
      // worden met de betrouwbare legacy-snapshot van 01/09/2026 — zonder
      // enige fake CountSession, via `ComparisonService`s legacy-periode-optie. ----
      const optionsWithLegacy = await deviceA.comparisonService.getComparisonOptions("lokeren");
      const legacyOption0901 = optionsWithLegacy.sessions.find(
        (s) => s.provenance === "LEGACY_IMPORT" && s.sessionName === "LEGACY 01/09/2026",
      );
      expect(legacyOption0901).toBeDefined();

      const legacyVsNew = await deviceA.comparisonService.compareSessions(
        "lokeren",
        legacyOption0901!.sessionId,
        session2.id,
      );
      expect(legacyVsNew.headerA.provenance).toBe("LEGACY_IMPORT");
      expect(legacyVsNew.headerB.provenance).toBe("APP_COUNT");
      expect(legacyVsNew.articles.length).toBeGreaterThan(0);
      // Nooit gefabriceerde telkwaliteit voor de legacy-kant (spec §1).
      expect(legacyVsNew.articles.every((a) => a.consecutiveUnchangedPhysicallyCountedCount <= a.consecutiveUnchangedCount)).toBe(
        true,
      );

      // ---- 8. Exporteren (de laatste, tweede telling) ----
      const exported = await deviceA.exportService.exportSessionResults(session2.id);

      // ---- 9. Repository B: volledig lege repository, herimporteren ----
      const deviceB = makeDevice();
      expect(await deviceB.repository.getOffice("lokeren")).toBeUndefined();

      const sourceB = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
      await deviceB.importService.commitImport(await deviceB.importService.prepareImport(sourceB));

      // --- Legacy-historiek + legacy-only artikelen overleven de export/import-cyclus ---
      const historyB = await deviceB.repository.getStockHistoryEntries("lokeren");
      const legacyEntriesB = historyB.filter((e) => e.status === "LEGACY");
      expect(legacyEntriesB.length).toBe(legacyEntries.length);
      expect(legacyEntriesB.every((e) => e.source === "LEGACY_IMPORT")).toBe(true);

      const articlesB = await deviceB.repository.getArticles("lokeren");
      const legacyOnlyArticlesB = articlesB.filter((a) => a.assortmentActive === false);
      expect(legacyOnlyArticlesB.length).toBe(legacyOnlyArticles.length);
      expect(legacyOnlyArticlesB.every((a) => a.status === "INACTIVE")).toBe(true);

      // --- Count-scope-regel geldt nog steeds correct op dit verse toestel ---
      const session3 = await deviceB.sessionService.startSession("lokeren", "MONTHLY");
      for (const legacyOnly of legacyOnlyArticlesB) {
        expect(session3.articleIds).not.toContain(legacyOnly.id);
      }

      // --- Sprint 3.3 §1/§7: dezelfde legacy-vs-nieuwe-telling vergelijking
      // werkt ook op dit tweede, blanco toestel (na export -> herimport) ---
      await countEntireSessionUnchanged(deviceB, "lokeren", session3);
      const optionsB = await deviceB.comparisonService.getComparisonOptions("lokeren");
      const legacyOption0901B = optionsB.sessions.find(
        (s) => s.provenance === "LEGACY_IMPORT" && s.sessionName === "LEGACY 01/09/2026",
      );
      expect(legacyOption0901B).toBeDefined();
      const legacyVsNewB = await deviceB.comparisonService.compareSessions(
        "lokeren",
        legacyOption0901B!.sessionId,
        session3.id,
      );
      expect(legacyVsNewB.headerA.provenance).toBe("LEGACY_IMPORT");
      expect(legacyVsNewB.articles.length).toBeGreaterThan(0);
    },
    30000,
  );

  const DAMME_LEGACY_FILE = "TGWVL - Stock 31.08.2026 - Telfrequentie.xlsx";
  const hasDammeFixture = fs.existsSync(path.join(LEGACY_FIXTURES_DIR, DAMME_LEGACY_FILE));
  const maybeItDamme = hasDammeFixture ? it : it.skip;

  /**
   * Damme (TGWVL) is bewust een APARTE, lichtere test i.p.v. hergebruik van
   * hetzelfde volledige scenario hierboven: de brondata is merkbaar
   * rommeliger (zie `parseLegacyStock.ts`'s eigen documentatie/eerdere
   * data-analyse — een veel lager matchpercentage, C4U-subbrandrijen zonder
   * artikelnummer, en meer anomalieën), dus dit dekt specifiek dat DIE
   * rommeligheid de import niet doet crashen of stilzwijgend data verliest,
   * zonder de volledige telling/analyse/vergelijking-keten te herhalen (die
   * is al kantoor-onafhankelijk bewezen door het Lokeren-scenario hierboven).
   */
  maybeItDamme(
    "Damme (TGWVL, rommeliger brondata incl. C4U): legacy-import blokkeert niet, en overleeft eveneens de export/import-cyclus",
    async () => {
      const deviceA = makeDevice();
      const masterBuffer = loadBuffer(path.join(FIXTURES_DIR, "Stocktelling_Damme_standaard.xlsx"));
      const sourceA = createExcelStockSourceFromBuffer(masterBuffer, "Stocktelling_Damme_standaard.xlsx");
      await deviceA.importService.commitImport(await deviceA.importService.prepareImport(sourceA));

      const legacyBuffer = loadBuffer(path.join(LEGACY_FIXTURES_DIR, DAMME_LEGACY_FILE));
      const legacyRows = parseLegacyStockDamme(legacyBuffer, DAMME_LEGACY_FILE);
      const legacyResult = await deviceA.legacyImportService.commit("damme", legacyRows);

      // Spec §3: "geen fuzzy auto-merge" + "blokkeer maandag niet" — ondanks
      // een gekend laag matchpercentage en meerdere anomalieën, importeert
      // dit gewoon ALLE rijen (nooit geblokkeerd/overgeslagen).
      expect(legacyResult.preview.totalRows).toBe(legacyRows.length);
      expect(legacyResult.preview.totalMatched + legacyResult.preview.totalUnresolved).toBe(legacyRows.length);
      expect(legacyResult.preview.periods).toHaveLength(7);

      // Sprint 3.3 §2: EXACTE rijreconciliatie — elke brondata-rij eindigt in
      // exact één van de drie uitkomsten, en hun som is ALTIJD gelijk aan het
      // totaal aantal rijen. Geen enkele rij mag stilzwijgend verdwijnen.
      expect(
        legacyResult.preview.totalMatchedExistingArticle +
          legacyResult.preview.totalNewHistoricalArticleRows +
          legacyResult.preview.totalRejectedRows,
      ).toBe(legacyRows.length);
      // Alle 7 periodesleutels zijn gekend voor de echte TGWVL-data -> nooit
      // een onbekende-periode-afwijzing in de praktijk.
      expect(legacyResult.preview.totalRejectedRows).toBe(0);

      const historyAfterLegacy = await deviceA.repository.getStockHistoryEntries("damme");
      const legacyEntries = historyAfterLegacy.filter((e) => e.status === "LEGACY");
      expect(legacyEntries.length).toBe(legacyResult.historyEntryCount);
      expect(legacyEntries.every((e) => e.source === "LEGACY_IMPORT")).toBe(true);

      const articlesAfterLegacy = await deviceA.repository.getArticles("damme");
      const legacyOnlyArticles = articlesAfterLegacy.filter((a) => a.assortmentActive === false);
      expect(legacyOnlyArticles.length).toBeGreaterThan(0);

      // Nieuwe telling: de legacy-only artikelen (incl. onopgeloste C4U-rijen
      // zonder artikelnummer) vallen buiten scope.
      const session = await deviceA.sessionService.startSession("damme", "MONTHLY");
      for (const legacyOnly of legacyOnlyArticles) {
        expect(session.articleIds).not.toContain(legacyOnly.id);
      }
      await countEntireSessionUnchanged(deviceA, "damme", session);

      // Export -> herimport op een tweede lege repository: alles overleeft.
      const exported = await deviceA.exportService.exportSessionResults(session.id);
      const deviceB = makeDevice();
      const sourceB = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
      await deviceB.importService.commitImport(await deviceB.importService.prepareImport(sourceB));

      const historyB = await deviceB.repository.getStockHistoryEntries("damme");
      const legacyEntriesB = historyB.filter((e) => e.status === "LEGACY");
      expect(legacyEntriesB.length).toBe(legacyEntries.length);

      const articlesB = await deviceB.repository.getArticles("damme");
      const legacyOnlyArticlesB = articlesB.filter((a) => a.assortmentActive === false);
      expect(legacyOnlyArticlesB.length).toBe(legacyOnlyArticles.length);
      expect(legacyOnlyArticlesB.every((a) => a.status === "INACTIVE")).toBe(true);
    },
    30000,
  );
});
