import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { ARTIKEL_HEADER_ROW, buildTestWorkbookBuffer, defaultConfigRows, defaultTellingRows } from "./testWorkbook";
import { ImportService } from "../../application/services/ImportService";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import { ExportService, SheetNameConflictError } from "../../application/services/ExportService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import { mergeArticleHistory } from "../../domain/articleHistory";
import { sessionSnapshotName } from "../../domain/stockSnapshot";

/**
 * Rollend stockarchief — volledige, end-to-end integratietests over de hele
 * stack (ImportService -> CountSessionService -> CountingService ->
 * ExportService -> ExcelStockResultExporter), inclusief het verplichte
 * roundtrip-scenario uit de opdracht: "bestaand bestand -> telling afronden
 * -> export -> reimport -> volgende telling -> export".
 *
 * `vi.setSystemTime` (enkel Date gefaket, timers blijven echt) simuleert
 * meerdere kalendermaanden/kwartalen, omdat de tellingtabnaam en
 * HISTORIE-datum uitsluitend uit `CountSession.completedAt` afgeleid worden.
 */

function buildInitialWorkbook(): ArrayBuffer {
  return buildTestWorkbookBuffer({
    configRows: defaultConfigRows("TestKantoor"),
    tellingRows: defaultTellingRows(),
    artikelRows: [
      ARTIKEL_HEADER_ROW,
      ["A1", "A1", "OFFICIEEL", "Artikel A1", "Groep", "Lev", "stuk", 2, "MAAND", "ACTIEF", 5, 2],
      ["Q1", "Q1", "OFFICIEEL", "Artikel Q1", "Groep", "Lev", "stuk", 3, "KWARTAAL", "ACTIEF", 12, 3],
    ],
  });
}

interface Stack {
  repository: InMemoryCountingRepository;
  importService: ImportService;
  sessionService: CountSessionService;
  countingService: CountingService;
  exportService: ExportService;
}

function buildStack(): Stack {
  const repository = new InMemoryCountingRepository();
  return {
    repository,
    importService: new ImportService(repository),
    sessionService: new CountSessionService(repository),
    countingService: new CountingService(repository),
    exportService: new ExportService(repository, new ExcelStockResultExporter()),
  };
}

async function completeMonthlyOrQuarterly(
  stack: Stack,
  officeId: string,
  type: "MONTHLY" | "QUARTERLY",
  quantitiesByArticleNumber: Record<string, number>,
) {
  const session = await stack.sessionService.startSession(officeId, type);
  const articles = await stack.repository.getArticles(officeId);
  const office = await stack.repository.getOffice(officeId);
  if (!office) throw new Error("kantoor niet gevonden");
  const firstLocationId = office.locations[0].id;

  for (const articleId of session.articleIds) {
    const article = articles.find((a) => a.id === articleId);
    if (!article) continue;
    const quantity = quantitiesByArticleNumber[article.articleNumber];
    if (quantity === undefined) continue;
    await stack.countingService.recordCount({ session, articleId, locationId: firstLocationId, quantity });
  }
  for (const location of office.locations.filter((l) => l.active)) {
    await stack.countingService.completeLocation(session.id, location.id);
  }
  await stack.sessionService.completeSession(session.id);
  return session;
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
}

describe("Rollend stockarchief — volledige workflow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "juli/augustus (OVERGENOMEN) -> Q3 fysieke telling: vorige fysieke telling wordt correct bepaald " +
      "ondanks tussenliggende OVERGENOMEN snapshots, en export -> reimport -> volgende telling -> export " +
      "behoudt alle historische tabs en HISTORIE-regels zonder duplicaten",
    async () => {
      vi.useFakeTimers({ toFake: ["Date"] });

      // --- Bestaand bestand importeren ---
      const stack1 = buildStack();
      vi.setSystemTime(new Date("2026-07-01T08:00:00.000Z"));
      const initialBuffer = buildInitialWorkbook();
      const source = createExcelStockSourceFromBuffer(initialBuffer, "TestKantoor_standaard.xlsx");
      await stack1.importService.commitImport(await stack1.importService.prepareImport(source));
      const officeId = (await source.loadOffice()).id;

      // --- Juli: maandtelling (enkel A1 in scope; Q1 blijft OVERGENOMEN) ---
      vi.setSystemTime(new Date("2026-07-31T15:00:00.000Z"));
      const julySession = await completeMonthlyOrQuarterly(stack1, officeId, "MONTHLY", { A1: 5 });
      const julyExport = await stack1.exportService.exportSessionResults(julySession.id);
      expect(sessionSnapshotName(julySession)).toBe("2026-07 Maand");
      expect(julyExport.newHistoricalSheet?.sheetName).toBe("2026-07 Maand");

      // --- Augustus: opnieuw een maandtelling (Q1 blijft OVERGENOMEN) ---
      vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));
      const augustusSession = await completeMonthlyOrQuarterly(stack1, officeId, "MONTHLY", { A1: 5 });
      const augustusExport = await stack1.exportService.exportSessionResults(augustusSession.id);
      expect(sessionSnapshotName(augustusSession)).toBe("2026-08 Maand");

      // Op dit punt: het augustusbestand moet ZOWEL "2026-07 Maand" ALS
      // "2026-08 Maand" bevatten (spec-voorbeeld) — "historische sheet wordt
      // bij volgende export behouden".
      let workbook = XLSX.read(augustusExport.data, { type: "array", cellDates: true });
      expect(workbook.SheetNames).toEqual(
        expect.arrayContaining(["2026-07 Maand", "2026-08 Maand", "ARTIKEL", "CONFIG", "HISTORIE", "NIEUWE_ARTIKELEN"]),
      );
      // Exact één nieuw tabblad per export — "2026-07 Maand" mag niet nog eens voorkomen.
      expect(workbook.SheetNames.filter((n) => n === "2026-07 Maand")).toHaveLength(1);

      // --- September: kwartaaltelling (Q1 nu WEL fysiek geteld: 9) ---
      vi.setSystemTime(new Date("2026-09-30T15:00:00.000Z"));
      const septemberSession = await completeMonthlyOrQuarterly(stack1, officeId, "QUARTERLY", { A1: 5, Q1: 9 });
      const septemberExport = await stack1.exportService.exportSessionResults(septemberSession.id);
      expect(sessionSnapshotName(septemberSession)).toBe("2026-Q3 Kwartaal");

      workbook = XLSX.read(septemberExport.data, { type: "array", cellDates: true });
      const q3Rows = sheetToRows(workbook.Sheets["2026-Q3 Kwartaal"]);
      const q3Header = q3Rows[0] as string[];
      const q3Col = (name: string) => q3Header.indexOf(name);
      const q1Row = q3Rows.find((r) => r[q3Col("Artikelnr.")] === "Q1")!;
      // Kern van het spec-voorbeeld: ondanks twee tussenliggende OVERGENOMEN
      // maandtellingen (juli, augustus) is "Vorige telling" nog steeds 12
      // (de laatste FYSIEKE telling, uit het originele bestand), en het
      // verschil dus -3, niet vervormd door de OVERGENOMEN-snapshots ertussen.
      expect(q1Row[q3Col("Vorige telling")]).toBe(12);
      expect(q1Row[q3Col("Nieuwe telling")]).toBe(9);
      expect(q1Row[q3Col("Verschil aantal")]).toBe(-3);
      expect(q1Row[q3Col("Status telling")]).toBe("GETELD");

      // De HISTORIE-log moet ondertussen 3 snapshots x 2 artikelen = 6 regels tellen.
      const historieRows = sheetToRows(workbook.Sheets["HISTORIE"]);
      const historieHeader = historieRows[0] as string[];
      const hcol = (name: string) => historieHeader.indexOf(name);
      const q1HistorieRows = historieRows.slice(1).filter((r) => r[hcol("Artikelnr.")] === "Q1");
      expect(q1HistorieRows.map((r) => r[hcol("Tellingnaam")])).toEqual([
        "2026-07 Maand",
        "2026-08 Maand",
        "2026-Q3 Kwartaal",
      ]);
      expect(q1HistorieRows.map((r) => r[hcol("Status telling")])).toEqual([
        "OVERGENOMEN",
        "OVERGENOMEN",
        "GETELD",
      ]);

      // (Het "naamconflict wordt niet stilletjes overschreven"-scenario staat
      // apart hieronder getest — hier gaat het verder met de roundtrip.)

      // --- Export -> reimport op een NIEUW toestel (lege repository) ---
      const stack2 = buildStack();
      const reimportedSource = createExcelStockSourceFromBuffer(septemberExport.data, septemberExport.fileName);
      await stack2.importService.commitImport(await stack2.importService.prepareImport(reimportedSource));

      // "nieuw toestel/browser": geen lokale CountSessions, maar de historische
      // tabs en HISTORIE moeten toch meteen beschikbaar zijn.
      const historicalSheetsAfterReimport = await stack2.repository.getHistoricalSheetSnapshots(officeId);
      expect(historicalSheetsAfterReimport.map((s) => s.sheetName).sort()).toEqual([
        "2026-07 Maand",
        "2026-08 Maand",
        "2026-Q3 Kwartaal",
      ]);
      const historyAfterReimport = await stack2.repository.getStockHistoryEntries(officeId);
      expect(historyAfterReimport).toHaveLength(6); // 3 snapshots x 2 artikelen, geen duplicaten

      // "artikelgrafiek kan uit geïmporteerde HISTORIE opgebouwd worden" —
      // zonder een enkele lokale CountSession op dit nieuwe toestel.
      const q1ArticleId = `${officeId}:Q1`;
      const merged = mergeArticleHistory(q1ArticleId, [], new Map(), historyAfterReimport);
      expect(merged.map((p) => p.sessionName)).toEqual(["2026-07 Maand", "2026-08 Maand", "2026-Q3 Kwartaal"]);
      expect(merged[2].totalCount).toBe(9);
      expect(merged[2].difference).toBe(-3);

      // --- Oktober: volgende maandtelling op het NIEUWE toestel, dan export ---
      vi.setSystemTime(new Date("2026-10-31T15:00:00.000Z"));
      const octoberSession = await completeMonthlyOrQuarterly(stack2, officeId, "MONTHLY", { A1: 6 });
      const octoberExport = await stack2.exportService.exportSessionResults(octoberSession.id);

      const finalWorkbook = XLSX.read(octoberExport.data, { type: "array", cellDates: true });
      // Alle 4 tellingtabs (3 oude + 1 nieuwe) moeten aanwezig zijn.
      expect(finalWorkbook.SheetNames).toEqual(
        expect.arrayContaining(["2026-07 Maand", "2026-08 Maand", "2026-Q3 Kwartaal", "2026-10 Maand"]),
      );
      // De 3 oude tabs moeten byte-/logisch ONGEWIJZIGD zijn t.o.v. de
      // september-export (nooit hergenereerd, gewoon doorgegeven).
      for (const sheetName of ["2026-07 Maand", "2026-08 Maand", "2026-Q3 Kwartaal"]) {
        expect(sheetToRows(finalWorkbook.Sheets[sheetName])).toEqual(sheetToRows(workbook.Sheets[sheetName]));
      }
      // HISTORIE is nu gegroeid met de oktober-snapshot, zonder duplicaten.
      const finalHistorie = sheetToRows(finalWorkbook.Sheets["HISTORIE"]);
      expect(finalHistorie).toHaveLength(1 + 4 * 2); // header + 4 snapshots x 2 artikelen
    },
  );

  it("een export van een sessie waarvan de snapshotnaam al door een ANDERE sessie/import bezet is, weigert (geen stille overschrijving)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stack = buildStack();
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    const source = createExcelStockSourceFromBuffer(buildInitialWorkbook(), "TestKantoor_standaard.xlsx");
    await stack.importService.commitImport(await stack.importService.prepareImport(source));
    const officeId = (await source.loadOffice()).id;

    vi.setSystemTime(new Date("2026-09-30T15:00:00.000Z"));
    const firstSession = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 5 });
    await stack.exportService.exportSessionResults(firstSession.id);

    // Simuleer een TWEEDE, onafhankelijke sessie die toevallig dezelfde naam
    // zou opleveren: rechtstreeks een conflicterende, "vreemde" historische
    // sheet in de repository plaatsen (zoals bij een import van een ander
    // bestand met dezelfde periode) en een NIEUWE sessie met dezelfde
    // (type, maand) proberen te exporteren.
    await stack.repository.saveHistoricalSheetSnapshot({
      officeId,
      sessionId: "een-andere-sessie",
      sheetName: "2026-10 Maand",
      rows: [["bestaand"]],
    });
    vi.setSystemTime(new Date("2026-10-15T08:00:00.000Z"));
    const conflictingSession = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 5 });
    expect(sessionSnapshotName(conflictingSession)).toBe("2026-10 Maand");

    await expect(stack.exportService.exportSessionResults(conflictingSession.id)).rejects.toThrow(
      SheetNameConflictError,
    );
  });

  it("een naamconflict kan opgelost worden met resolution 'overwrite' (het botsende tabblad wordt vervangen)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stack = buildStack();
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    const source = createExcelStockSourceFromBuffer(buildInitialWorkbook(), "TestKantoor_standaard.xlsx");
    await stack.importService.commitImport(await stack.importService.prepareImport(source));
    const officeId = (await source.loadOffice()).id;

    await stack.repository.saveHistoricalSheetSnapshot({
      officeId,
      sessionId: "een-andere-sessie",
      sheetName: "2026-10 Maand",
      rows: [["bestaand"]],
    });
    vi.setSystemTime(new Date("2026-10-15T08:00:00.000Z"));
    const session = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 7 });
    expect(sessionSnapshotName(session)).toBe("2026-10 Maand");

    // Zonder resolution: nog steeds een conflict (ongewijzigd gedrag).
    await expect(stack.exportService.exportSessionResults(session.id)).rejects.toThrow(SheetNameConflictError);

    // Met expliciete overwrite-bevestiging: geen conflict meer, en het
    // resulterende tabblad bevat de VERSE data van deze sessie, niet de oude
    // "bestaand"-placeholderrij.
    const exported = await stack.exportService.exportSessionResults(session.id, { action: "overwrite" });
    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    expect(workbook.SheetNames).toContain("2026-10 Maand");
    const rows = sheetToRows(workbook.Sheets["2026-10 Maand"]);
    expect(rows.some((row) => row.includes("bestaand"))).toBe(false);
    expect(rows.some((row) => row.includes("A1"))).toBe(true);
  });

  it("een naamconflict kan opgelost worden met resolution 'rename' (eigen naam, het botsende tabblad blijft ongemoeid)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stack = buildStack();
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    const source = createExcelStockSourceFromBuffer(buildInitialWorkbook(), "TestKantoor_standaard.xlsx");
    await stack.importService.commitImport(await stack.importService.prepareImport(source));
    const officeId = (await source.loadOffice()).id;

    await stack.repository.saveHistoricalSheetSnapshot({
      officeId,
      sessionId: "een-andere-sessie",
      sheetName: "2026-10 Maand",
      rows: [["bestaand"]],
    });
    vi.setSystemTime(new Date("2026-10-15T08:00:00.000Z"));
    const session = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 7 });

    const exported = await stack.exportService.exportSessionResults(session.id, {
      action: "rename",
      sheetName: "2026-10 Maand (herteld)",
    });
    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    // Het botsende tabblad ("bestaand") blijft ongemoeid staan, en de nieuwe
    // export komt erbij onder de eigen, gekozen naam.
    expect(workbook.SheetNames).toEqual(
      expect.arrayContaining(["2026-10 Maand", "2026-10 Maand (herteld)"]),
    );
    expect(sheetToRows(workbook.Sheets["2026-10 Maand"])).toEqual([["bestaand"]]);
    const renamedRows = sheetToRows(workbook.Sheets["2026-10 Maand (herteld)"]);
    expect(renamedRows.some((row) => row.includes("A1"))).toBe(true);

    // Een tweede rename naar een naam die ZELF ook al bezet is, blijft een
    // conflict — de gebruiker moet dan opnieuw kiezen.
    await expect(
      stack.exportService.exportSessionResults(session.id, {
        action: "rename",
        sheetName: "2026-10 Maand",
      }),
    ).rejects.toThrow(SheetNameConflictError);
  });

  it("een herhaalde export van DEZELFDE, al afgeronde sessie is GEEN conflict en hergebruikt het bevroren tabblad", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stack = buildStack();
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    const source = createExcelStockSourceFromBuffer(buildInitialWorkbook(), "TestKantoor_standaard.xlsx");
    await stack.importService.commitImport(await stack.importService.prepareImport(source));
    const officeId = (await source.loadOffice()).id;

    vi.setSystemTime(new Date("2026-09-30T15:00:00.000Z"));
    const session = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 5 });
    const firstExport = await stack.exportService.exportSessionResults(session.id);
    const secondExport = await stack.exportService.exportSessionResults(session.id);

    const firstWorkbook = XLSX.read(firstExport.data, { type: "array", cellDates: true });
    const secondWorkbook = XLSX.read(secondExport.data, { type: "array", cellDates: true });
    expect(sheetToRows(secondWorkbook.Sheets["2026-09 Maand"])).toEqual(
      sheetToRows(firstWorkbook.Sheets["2026-09 Maand"]),
    );
  });

  it(
    "een export werkt Article.previousCount meteen bij in de levende appdata (aanvulling: \"bij een " +
      "volgende telling wil ik ook het aantal van de vorige telling zien\"), zonder de export van DEZE " +
      "sessie zelf te vervalsen, en zonder een herhaalde export nog eens te verschuiven",
    async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const stack = buildStack();
      vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
      const source = createExcelStockSourceFromBuffer(buildInitialWorkbook(), "TestKantoor_standaard.xlsx");
      await stack.importService.commitImport(await stack.importService.prepareImport(source));
      const officeId = (await source.loadOffice()).id;

      // September: maandtelling, enkel A1 fysiek geteld (6) — Q1 blijft dan
      // OVERGENOMEN (geen kwartaalartikel deze keer).
      vi.setSystemTime(new Date("2026-09-30T15:00:00.000Z"));
      const session = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 6 });
      const exported = await stack.exportService.exportSessionResults(session.id);

      // De export van DEZE sessie zelf moet nog steeds de ECHTE, oorspronkelijke
      // "Vorige telling" (2) tonen — niet vervalst door de meteen-nadien
      // toegepaste synchronisatie naar de levende artikeldata.
      const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
      const sRows = sheetToRows(workbook.Sheets["2026-09 Maand"]);
      const sHeader = sRows[0] as string[];
      const sCol = (name: string) => sHeader.indexOf(name);
      const a1Row = sRows.find((r) => r[sCol("Artikelnr.")] === "A1")!;
      expect(a1Row[sCol("Vorige telling")]).toBe(5);
      expect(a1Row[sCol("Nieuwe telling")]).toBe(6);
      expect(a1Row[sCol("Verschil aantal")]).toBe(1);

      // De levende appdata (repository.getArticles) moet WEL meteen bijgewerkt
      // zijn: A1 (fysiek geteld) krijgt 6 als nieuwe basis, Q1 (OVERGENOMEN,
      // niet in scope deze sessie) blijft ongemoeid op zijn oude waarde (12).
      const articlesAfter = await stack.repository.getArticles(officeId);
      const a1Article = articlesAfter.find((a) => a.articleNumber === "A1")!;
      const q1Article = articlesAfter.find((a) => a.articleNumber === "Q1")!;
      expect(a1Article.previousCount).toBe(6);
      expect(q1Article.previousCount).toBe(12);

      // Een HERHAALDE export van dezelfde sessie hergebruikt het bevroren
      // tabblad en mag de basis niet nog eens laten verschuiven (anders zou
      // een volgende, oprechte fysieke telling tegen een verkeerde basis
      // vergeleken worden).
      await stack.exportService.exportSessionResults(session.id);
      const articlesAfterSecondExport = await stack.repository.getArticles(officeId);
      expect(articlesAfterSecondExport.find((a) => a.articleNumber === "A1")!.previousCount).toBe(6);
    },
  );

  it("nieuwe tijdelijke artikelen bouwen vanaf hun aanmaak historie op", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stack = buildStack();
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    const source = createExcelStockSourceFromBuffer(buildInitialWorkbook(), "TestKantoor_standaard.xlsx");
    await stack.importService.commitImport(await stack.importService.prepareImport(source));
    const officeId = (await source.loadOffice()).id;

    // Een nieuw, tijdelijk artikel "gevonden tijdens het tellen" (spec: komt
    // vanaf aanmaak in ARTIKEL en bouwt vanaf dan historie op).
    const tempArticleId = `${officeId}:TMP-0001`;
    const existingArticles = await stack.repository.getArticles(officeId);
    await stack.repository.saveArticles([
      ...existingArticles,
      {
        id: tempArticleId,
        officeId,
        articleNumber: "TMP-0001",
        officialArticleNumber: null,
        idType: "TIJDELIJK",
        description: "Nieuw gevonden onderdeel",
        productGroup: "GROEP",
        supplier: null,
        unit: "stuk",
        costPrice: 1,
        rawCountPeriod: "MAAND",
        countPeriod: "MONTHLY",
        rawStatus: "ACTIEF",
        status: "ACTIVE",
        previousCount: null,
        sourceRow: 999,
      },
    ]);

    vi.setSystemTime(new Date("2026-09-30T15:00:00.000Z"));
    const session = await completeMonthlyOrQuarterly(stack, officeId, "MONTHLY", { A1: 5, "TMP-0001": 3 });
    const exported = await stack.exportService.exportSessionResults(session.id);

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const historieRows = sheetToRows(workbook.Sheets["HISTORIE"]);
    const header = historieRows[0] as string[];
    const col = (name: string) => header.indexOf(name);
    const tempRow = historieRows.find((r) => r[col("Artikelnr.")] === "TMP-0001")!;
    expect(tempRow[col("Status telling")]).toBe("GETELD");
    expect(tempRow[col("Totale voorraad")]).toBe(3);
  });
});
