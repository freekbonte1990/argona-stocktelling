import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";
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
import { isArticleActiveInAssortment } from "../../domain/articleAssortment";
import { renameLocation, reorderLocations } from "../../domain/locations";
import { getStockClassification } from "../../domain/stockClassification";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
import type { LegacyStockRow } from "../../domain/legacyImport";

/**
 * Production-pilot-readiness sprint punt 2 ("Fresh repository roundtrip") —
 * HARDE acceptatievoorwaarde: bewijst dat de volledige keten
 * `tablet/browser A -> import -> tellen -> afronden -> Excel export ->
 * volledig lege tablet/browser B -> import -> volgende telling` werkt met
 * TWEE écht onafhankelijke `CountingRepository`-instanties (elk zijn eigen
 * `InMemoryCountingRepository`, eigen services) — in tegenstelling tot
 * `exportRoundtrip.integration.test.ts`, dat de herimport enkel als losse
 * `StockSource` uitleest zonder ooit in een tweede, écht lege repository te
 * COMMITTEN. Hier wordt Repository B pas na de reimport voor het eerst iets
 * over dit kantoor te weten — exact "browser B" op maandagochtend.
 *
 * Test bewust ook meteen de locatie-identiteit-stabiliteit (punt 1): Repository
 * A hernoemt EN herordent een locatie tussen tellen en exporteren, en
 * Repository B moet dezelfde onderliggende locatie via dezelfde `Location.id`
 * terugvinden — niet via haar (intussen andere) weergavenummer/naam.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../test-fixtures");

function loadFixtureBuffer(fileName: string): ArrayBuffer {
  const filePath = path.join(FIXTURES_DIR, fileName);
  const nodeBuffer = fs.readFileSync(filePath);
  return nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
}

/** Bouwt een volledig bedraad "toestel" (repository + services) — gebruikt voor zowel A als B. */
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

describe("Fresh repository roundtrip (production-pilot-readiness sprint punt 2 — harde acceptatievoorwaarde)", () => {
  it(
    "Repository A telt/rondt af/exporteert; een volledig lege Repository B importeert dat bestand en kent meteen kantoor, locaties (incl. hernoemd/herordend), artikelen, historie én de geleerde locatiekoppeling",
    async () => {
      // ---- Repository A: import, tellen (incl. onverwachte locatie), leren, afronden, exporteren ----
      const deviceA = makeDevice();
      const buffer = loadFixtureBuffer("Stocktelling_Lokeren_standaard.xlsx");
      const sourceA = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Lokeren_standaard.xlsx");
      await deviceA.importService.commitImport(await deviceA.importService.prepareImport(sourceA));

      // Locatie-identiteit-stabiliteit (punt 1): Rek 3 hernoemen én herordenen
      // (naar de EERSTE positie) vóór er ooit geteld/geëxporteerd is — de
      // locatie-ID zelf mag daar nooit door veranderen.
      const officeBeforeCounting = await deviceA.repository.getOffice("lokeren");
      if (!officeBeforeCounting) throw new Error("kantoor 'lokeren' niet gevonden in Repository A");
      const renamed = renameLocation(officeBeforeCounting, "lokeren:loc-3", "Rek Voorraadkast");
      const reordered = reorderLocations(
        renamed,
        // loc-3 eerst, de rest in oorspronkelijke volgorde erna.
        ["lokeren:loc-3", "lokeren:loc-1", "lokeren:loc-2", "lokeren:loc-4", "lokeren:loc-5"],
      );
      await deviceA.repository.saveOffice(reordered);

      // Sprint 3.3 §6 ("Excel portability"): office-assortment-vlaggen
      // (§1) moeten dezelfde export/import-cyclus overleven als
      // stockClassification/categoryId — additief, via de kolom
      // "Assortiment actief" in ARTIKEL (zie `parseArtikel.ts`/
      // `ExcelStockResultExporter.ts`). Bewust VÓÓR het starten van de
      // sessie inactief gemaakt, zodat het meteen ook buiten de scope van
      // de nieuwe sessie valt (spec §2, `selectArticlesForNewCount`).
      const articlesBeforeSession = await deviceA.repository.getArticles("lokeren");
      const historicalOnlyArticle = articlesBeforeSession[articlesBeforeSession.length - 1];
      if (!historicalOnlyArticle) throw new Error("geen artikelen gevonden voor kantoor 'lokeren'");
      await deviceA.repository.saveArticles([{ ...historicalOnlyArticle, assortmentActive: false }]);

      // Sprint 3.3 §3/§6 ("legacy historische import" + "Excel portability"):
      // een legacy-snapshot (status LEGACY, source LEGACY_IMPORT — nooit een
      // echte CountSession) moet dezelfde export/import-cyclus overleven als
      // elke andere HISTORIE-regel, inclusief haar eigen nieuwe "Bron"-kolom
      // (zie `parseHistorie.ts#HISTORIE_SOURCE_HEADER`). Bewust een rij ZONDER
      // artikelnummer (dus onopgelost -> eigen nieuw, historisch/inactief
      // artikel) — dat dekt meteen ook `plan.newArticles` in dit end-to-end pad.
      const legacyRows: LegacyStockRow[] = [
        {
          periodKey: "2025-03-31",
          sourceProductGroup: "Legacy testgroep",
          description: "Legacy testartikel vóór deze app",
          articleNumber: null,
          originalCostPrice: 12.5,
          quantity: 4,
          obsolete: false,
          sourceRef: "TEST-LEGACY!A1",
        },
      ];
      await deviceA.legacyImportService.commit("lokeren", legacyRows);
      const legacyEntryBeforeExport = (await deviceA.repository.getStockHistoryEntries("lokeren")).find(
        (e) => e.status === "LEGACY",
      );
      expect(legacyEntryBeforeExport).toBeDefined();
      expect(legacyEntryBeforeExport!.source).toBe("LEGACY_IMPORT");

      const session = await deviceA.sessionService.startSession("lokeren", "MONTHLY");
      expect(session.articleIds.length).toBeGreaterThan(0);
      expect(session.articleIds).not.toContain(historicalOnlyArticle.id);

      const allArticlesA = await deviceA.repository.getArticles("lokeren");
      const articleByIdA = new Map(allArticlesA.map((a) => [a.id, a]));

      // Het eerste sessiescope-artikel wordt bewust op een ONVERWACHTE locatie
      // geteld (er bestond nog geen enkele ArticleLocationAssignment voor dit
      // kantoor — de allereerste telling ooit) met een NIEUWE hoeveelheid, die
      // straks de "vorige fysieke telling" voor Repository B moet worden.
      const targetArticleId = session.articleIds[0];
      const targetArticle = articleByIdA.get(targetArticleId);
      if (!targetArticle) throw new Error(`artikel ${targetArticleId} niet gevonden`);

      // Sprint 2 (Historical Count Analysis) §14 ("Excel portability"):
      // `stockClassification` (ACTIVE/OBSOLETE) moet dezelfde
      // export/import-cyclus overleven als de rest van de artikelstam —
      // additief, via de kolom "Voorraadclassificatie" in ARTIKEL. Bewust
      // via een immutabele spread-kopie (`saveArticles`), exact zoals
      // ArticleDetailPage dat doet, nooit een mutatie van het bestaande
      // object.
      await deviceA.repository.saveArticles([{ ...targetArticle, stockClassification: "OBSOLETE" }]);

      const newQuantityForTarget = (targetArticle.previousCount ?? 0) + 17;
      await deviceA.countingService.recordCount({
        session,
        articleId: targetArticleId,
        // De hernoemde/herordende locatie — nog steeds hetzelfde `Location.id`.
        locationId: "lokeren:loc-3",
        quantity: newQuantityForTarget,
      });

      // De rest van de sessiescope gewoon op locatie 1 tellen (zelfde waarde
      // als de vorige telling — geen verschil nodig voor deze test).
      for (const articleId of session.articleIds) {
        if (articleId === targetArticleId) continue;
        const article = articleByIdA.get(articleId);
        if (!article) throw new Error(`artikel ${articleId} niet gevonden`);
        await deviceA.countingService.recordCount({
          session,
          articleId,
          locationId: "lokeren:loc-1",
          quantity: article.previousCount ?? 0,
        });
      }

      const officeWithLocations = await deviceA.repository.getOffice("lokeren");
      if (!officeWithLocations) throw new Error("kantoor 'lokeren' niet gevonden in Repository A");
      for (const location of officeWithLocations.locations.filter((l) => l.active)) {
        await deviceA.countingService.completeLocation(session.id, location.id);
      }
      await deviceA.sessionService.completeSession(session.id);

      const historyBeforeExport = await deviceA.repository.getStockHistoryEntries("lokeren");
      expect(historyBeforeExport.length).toBeGreaterThan(0);

      const exported = await deviceA.exportService.exportSessionResults(session.id);

      // ---- Repository B: VOLLEDIG LEEG (nooit eerder iets van dit kantoor gezien) ----
      const deviceB = makeDevice();
      expect(await deviceB.repository.getOffice("lokeren")).toBeUndefined();

      const sourceB = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
      const importSummaryB = await deviceB.importService.commitImport(
        await deviceB.importService.prepareImport(sourceB),
      );

      // --- Kantoor/locaties/artikelen hersteld ---
      const officeB = await deviceB.repository.getOffice("lokeren");
      expect(officeB).toBeDefined();
      expect(officeB!.name).toBe("Lokeren");
      expect(importSummaryB.activeLocationCount).toBe(5);

      const renamedLocationInB = officeB!.locations.find((l) => l.id === "lokeren:loc-3");
      expect(renamedLocationInB).toBeDefined();
      // Locatie-identiteit-stabiliteit: dezelfde `id` als in Repository A,
      // MET de hernoemde naam, ondanks de herordening.
      expect(renamedLocationInB!.name).toBe("Rek Voorraadkast");
      expect(renamedLocationInB!.number).toBe(1); // eerste positie na herordenen

      const articlesB = await deviceB.repository.getArticles("lokeren");
      expect(articlesB).toHaveLength(allArticlesA.length);

      // --- Sprint 3.3 §6: office-assortment-vlag hersteld, artikel blijft
      // wél gewoon raadpleegbaar (spec: "historical appearances must remain
      // visible even if the article is now inactive") ---
      const historicalOnlyArticleB = articlesB.find((a) => a.id === historicalOnlyArticle.id);
      expect(historicalOnlyArticleB).toBeDefined();
      expect(isArticleActiveInAssortment(historicalOnlyArticleB!)).toBe(false);

      // --- Voorraadclassificatie hersteld (Sprint 2 §14) ---
      const targetArticleClassificationCheck = articlesB.find((a) => a.id === targetArticleId);
      expect(targetArticleClassificationCheck).toBeDefined();
      expect(getStockClassification(targetArticleClassificationCheck!)).toBe("OBSOLETE");
      // Elk ander artikel (nooit expliciet gewijzigd) blijft veilig ACTIVE —
      // geen enkel artikel wordt stilzwijgend OBSOLETE door de export/import-cyclus.
      const anyOtherArticleB = articlesB.find((a) => a.id !== targetArticleId);
      expect(anyOtherArticleB).toBeDefined();
      expect(getStockClassification(anyOtherArticleB!)).toBe("ACTIVE");

      // --- Historie hersteld ---
      const historyB = await deviceB.repository.getStockHistoryEntries("lokeren");
      expect(historyB.length).toBeGreaterThan(0);
      expect(importSummaryB.lastHistoricalCount).not.toBeNull();

      // --- Sprint 3.3 §3/§6: de legacy-HISTORIE-regel (status LEGACY, source
      // LEGACY_IMPORT) en haar bijhorende nieuwe historisch/inactieve artikel
      // overleven de volledige export/import-cyclus, met haar eigen "Bron"-
      // kolom correct hersteld — nooit stilzwijgend gedegradeerd tot een
      // gewone "APP"-regel/GETELD-status. ---
      const legacyEntryB = historyB.find((e) => e.status === "LEGACY");
      expect(legacyEntryB).toBeDefined();
      expect(legacyEntryB!.source).toBe("LEGACY_IMPORT");
      expect(legacyEntryB!.sessionName).toBe("LEGACY 31/03/2025");
      expect(legacyEntryB!.totalCount).toBe(4);
      const legacyArticleB = articlesB.find((a) => a.id === legacyEntryB!.articleId);
      expect(legacyArticleB).toBeDefined();
      expect(legacyArticleB!.status).toBe("INACTIVE");
      expect(legacyArticleB!.assortmentActive).toBe(false);

      // --- Vervolg ("makkelijk vergelijken tussen toestellen"): de sessie
      // zelf (niet enkel haar HISTORIE-regels) wordt op Repository B
      // gereconstrueerd als een volwaardige, lokale COMPLETED CountSession —
      // ze verschijnt dus gewoon als "Vorige telling", is analyseerbaar én
      // vergelijkbaar, net zoals op Repository A zelf. ---
      const sessionAFinal = await deviceA.repository.getSession(session.id);
      if (!sessionAFinal) throw new Error("sessie niet gevonden in Repository A");
      const expectedSessionName = sessionSnapshotName(sessionAFinal);

      const sessionsB = await deviceB.repository.getSessionsForOffice("lokeren");
      const reconstructedSessionB = sessionsB.find((s) => sessionSnapshotName(s) === expectedSessionName);
      expect(reconstructedSessionB).toBeDefined();
      expect(reconstructedSessionB!.status).toBe("COMPLETED");
      // Stabiele identiteit over toestellen heen (zie
      // StockHistoryEntry#sourceSessionId): Repository B heeft deze sessie
      // nooit zelf geteld, maar herkent haar via het meegeëxporteerde
      // originele CountSession.id — niet enkel via de (zwakkere)
      // sessienaam/datum-heuristiek.
      expect(reconstructedSessionB!.id).toBe(session.id);

      const finalizedB = await deviceB.repository.getFinalizedSessionResult(reconstructedSessionB!.id);
      expect(finalizedB).toBeDefined();

      // Analyseerbaar — exact dezelfde kern-KPI (voorraadwaarde) als op
      // Repository A zelf, ondanks dat Repository B deze sessie nooit zelf
      // geteld heeft.
      const analysisA = await deviceA.analysisService.getSessionAnalysis(session.id);
      const analysisB = await deviceB.analysisService.getSessionAnalysis(reconstructedSessionB!.id);
      expect(analysisB.kpis.totalStockValue).toBe(analysisA.kpis.totalStockValue);

      // Vergelijkbaar — gewoon een normale optie in "Vergelijken", niet enkel
      // een legacy-achtige uitzondering.
      const comparisonOptionsB = await deviceB.comparisonService.getComparisonOptions("lokeren");
      const optionB = comparisonOptionsB.sessions.find((o) => o.sessionId === reconstructedSessionB!.id);
      expect(optionB).toBeDefined();
      expect(optionB!.provenance).toBe("APP_COUNT");

      // Vergelijken tegen de bestaande legacy-snapshot (van dezelfde import)
      // werkt ook gewoon, zonder enige speciale behandeling.
      const legacyOptionB = comparisonOptionsB.sessions.find((o) => o.provenance === "LEGACY_IMPORT");
      expect(legacyOptionB).toBeDefined();
      const comparisonVsLegacy = await deviceB.comparisonService.compareSessions(
        "lokeren",
        legacyOptionB!.sessionId,
        reconstructedSessionB!.id,
      );
      expect(comparisonVsLegacy.headerB.sessionId).toBe(reconstructedSessionB!.id);

      // --- Geleerde ArticleLocationAssignment hersteld (punt 1: kernvereiste) ---
      const assignmentsB = await deviceB.repository.getArticleLocationAssignments("lokeren");
      const targetAssignmentB = assignmentsB.find(
        (a) => a.articleId === targetArticleId && a.locationId === "lokeren:loc-3",
      );
      expect(targetAssignmentB).toBeDefined();
      expect(targetAssignmentB!.active).toBe(true);

      // --- Nieuwe telling starten: artikel wordt op de juiste locatie verwacht ---
      const nextSession = await deviceB.sessionService.startSession("lokeren", "MONTHLY");
      // Het assortiment-inactieve artikel blijft ook op dit VERSE toestel
      // buiten de scope van een nieuwe telling.
      expect(nextSession.articleIds).not.toContain(historicalOnlyArticle.id);
      const expectedAtRenamedLocation = await deviceB.countingService.getExpectedArticleIds(
        "lokeren",
        "lokeren:loc-3",
      );
      expect(expectedAtRenamedLocation.has(targetArticleId)).toBe(true);

      const nextSessionEntries = await deviceB.repository.getCountEntries(nextSession.id);
      const stubEntry = nextSessionEntries.find(
        (e) => e.articleId === targetArticleId && e.locationId === "lokeren:loc-3",
      );
      expect(stubEntry).toBeDefined();
      expect(stubEntry!.counted).toBe(false); // nog niet geteld deze nieuwe sessie — enkel de verwachting is hersteld

      // --- Correcte vorige fysieke telling ---
      const targetArticleB = (await deviceB.repository.getArticles("lokeren")).find(
        (a) => a.id === targetArticleId,
      );
      expect(targetArticleB?.previousCount).toBe(newQuantityForTarget);

      const nextReview = await deviceB.sessionService.getReview(nextSession.id);
      const targetReviewResult = nextReview.results.find((r) => r.articleId === targetArticleId);
      expect(targetReviewResult?.previousCount).toBe(newQuantityForTarget);

      // --- Expliciet gevraagde eindcheck ("makkelijk vergelijken tussen
      // toestellen", punt 1/5): exact hetzelfde geëxporteerde bestand NOG EEN
      // KEER importeren op Repository B (bv. een gebruiker die per ongeluk
      // twee keer op "Importeer" klikt) creëert nooit een tweede/dubbele
      // telling — nog steeds exact één sessie voor deze tellingnaam, met
      // dezelfde stabiele id. ---
      const sourceBAgain = createExcelStockSourceFromBuffer(exported.data, exported.fileName);
      await deviceB.importService.commitImport(await deviceB.importService.prepareImport(sourceBAgain));
      const sessionsBAfterReimport = await deviceB.repository.getSessionsForOffice("lokeren");
      // Scope bewust tot COMPLETED: Repository B heeft intussen ook zelf een
      // eigen, nog ACTIEVE "volgende telling" (`nextSession`, hierboven) die
      // toevallig dezelfde kalendermaand-naam kan dragen — dat is een
      // volledig ANDERE, echte sessie, geen dubbele reconstructie, en mag
      // deze check dus niet vervuilen.
      const matchingAfterReimport = sessionsBAfterReimport.filter(
        (s) => s.status === "COMPLETED" && sessionSnapshotName(s) === expectedSessionName,
      );
      expect(matchingAfterReimport).toHaveLength(1);
      expect(matchingAfterReimport[0].id).toBe(reconstructedSessionB!.id);
    },
    30000,
  );
});
