import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { computeSessionReview, type SessionReviewSummary } from "../../domain/review";
import { buildHistoryEntriesFromSnapshot, buildSessionSnapshot } from "../../domain/stockSnapshot";
import type { Article, ArticleLocationAssignment, CountEntry, CountSession, Office } from "../../domain/types";

/** Test-helper: bouwt de nieuwe, verplichte snapshot/historie-input vanuit een reeds berekende review. */
function buildSnapshotInputs(session: CountSession, allArticles: Article[], review: SessionReviewSummary) {
  const snapshot = buildSessionSnapshot(session, allArticles, review);
  const historyEntries = buildHistoryEntriesFromSnapshot(snapshot, office.locations);
  return { snapshot, historicalSheets: [], historyEntries };
}

const office: Office = {
  id: "damme",
  name: "Damme",
  baseDate: "2026-08-28",
  locations: [1, 2, 3, 4, 5].map((n) => ({
    id: `damme:loc-${n}`,
    officeId: "damme",
    number: n,
    name: `Locatie ${n}`,
    active: true,
  })),
};

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return {
    id: `damme:${articleNumber}`,
    officeId: "damme",
    articleNumber,
    officialArticleNumber: articleNumber,
    idType: "OFFICIEEL",
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "STUKS",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 10,
    sourceRow: 1,
    ...overrides,
  };
}

function makeEntry(articleId: string, locationId: string, overrides: Partial<CountEntry> = {}): CountEntry {
  return {
    id: `session-1:${articleId}:${locationId}`,
    sessionId: "session-1",
    articleId,
    locationId,
    quantity: null,
    counted: false,
    countedAt: null,
    note: null,
    resolution: "COUNTED",
    ...overrides,
  };
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
}

/**
 * Aanvulling ("exacte layout"): TELLING toont sinds de opmaakupdate een
 * metadatablok (Kantoor/Bronbestand/Basisdatum/Opmerking) en een titelrij
 * BOVEN de headerrij (spiegelt het bronsjabloon, waar de header op rij 14
 * staat, niet rij 1) — precies zoals de echte import ook nooit aanneemt dat
 * de header op een vaste rij staat (zie `excelHeaderUtils.ts#findHeaderRow`).
 * Deze testhelper doet hetzelfde: de header is de eerste rij die "Artikelnr."
 * bevat, ongeacht op welke rij-index dat is.
 */
function findHeaderRowAndData(rows: unknown[][]): { header: unknown[]; dataRows: unknown[][] } {
  const headerIndex = rows.findIndex((row) => row.includes("Artikelnr."));
  if (headerIndex === -1) throw new Error("Geen headerrij met 'Artikelnr.' gevonden.");
  return { header: rows[headerIndex], dataRows: rows.slice(headerIndex + 1) };
}

describe("ExcelStockResultExporter", () => {
  it("schrijft TELLING/ARTIKEL/CONFIG/NIEUWE_ARTIKELEN met de juiste berekende waarden", async () => {
    const countedArticle = makeArticle("A1", { previousCount: 10, costPrice: 2 }); // -> 7, verschil -3
    const outOfScopeArticle = makeArticle("Q1", {
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
      previousCount: 40,
    });
    const allArticles = [countedArticle, outOfScopeArticle];

    const entries: CountEntry[] = [
      makeEntry("damme:A1", "damme:loc-1", { quantity: 3, counted: true }),
      makeEntry("damme:A1", "damme:loc-3", { quantity: 4, counted: true }),
    ];

    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-28T15:00:00.000Z",
      sourceFileName: "Stocktelling_Damme_standaard.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: ["damme:A1"],
    };

    const review = computeSessionReview(session, allArticles, office.locations, entries);
    const exporter = new ExcelStockResultExporter();
    const exported = await exporter.exportResults({
      office,
      session,
      review,
      allArticles,
      assignments: [],
      ...buildSnapshotInputs(session, allArticles, review),
    });

    expect(exported.fileName).toBe("2026-08-28 - Stocktelling Damme.xlsx");

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    expect(workbook.SheetNames).toEqual(
      expect.arrayContaining(["TELLING", "ARTIKEL", "CONFIG", "NIEUWE_ARTIKELEN"]),
    );

    // --- TELLING ---
    const { header: tellingHeaderRow, dataRows: tellingDataRows } = findHeaderRowAndData(
      sheetToRows(workbook.Sheets["TELLING"]),
    );
    const tellingHeader = tellingHeaderRow as string[];
    const col = (name: string) => tellingHeader.indexOf(name);
    const a1Row = tellingDataRows.find((r) => r[col("Artikelnr.")] === "A1")!;
    expect(a1Row[col("LOCATIE 1")]).toBe(3);
    expect(a1Row[col("LOCATIE 3")]).toBe(4);
    expect(a1Row[col("LOCATIE 2")]).toBeNull();
    expect(a1Row[col("AANTAL TOTAAL")]).toBe(7);
    expect(a1Row[col("Bedrag")]).toBe(14); // 7 * 2
    expect(a1Row[col("Verschil Bedrag")]).toBe(-6); // -3 * 2
    expect(a1Row[col("VERSCHIL AANTAL")]).toBe(-3);
    expect(a1Row[col("GETELD?")]).toBe("JA");
    expect(a1Row[col("Vorige telling")]).toBe(10);
    expect(a1Row[col("Waarde vorige telling")]).toBe(20);

    // Artikel dat niet in scope zat: geen verse tellingdata, geen "NEE" (niet relevant deze cyclus).
    const q1Row = tellingDataRows.find((r) => r[col("Artikelnr.")] === "Q1")!;
    expect(q1Row[col("LOCATIE 1")]).toBeNull();
    expect(q1Row[col("AANTAL TOTAAL")]).toBeNull();
    expect(q1Row[col("GETELD?")]).toBeNull();
    expect(q1Row[col("Vorige telling")]).toBe(40);

    // --- ARTIKEL: "Vorige telling" is bijgewerkt voor A1, ongewijzigd voor Q1 ---
    const artikelRows = sheetToRows(workbook.Sheets["ARTIKEL"]);
    const artikelHeader = artikelRows[0] as string[];
    const acol = (name: string) => artikelHeader.indexOf(name);
    const artikelA1 = artikelRows.find((r) => r[acol("Artikelnr.")] === "A1")!;
    expect(artikelA1[acol("Vorige telling")]).toBe(7); // nieuwe totale telling wordt volgende "vorige telling"
    const artikelQ1 = artikelRows.find((r) => r[acol("Artikelnr.")] === "Q1")!;
    expect(artikelQ1[acol("Vorige telling")]).toBe(40); // ongewijzigd

    // --- CONFIG ---
    const configRows = sheetToRows(workbook.Sheets["CONFIG"]);
    const configMap = new Map(configRows.map((r) => [String(r[0]).toLowerCase(), r[1]]));
    expect(configMap.get("kantoor")).toBe("Damme");
    const basisdatum = configMap.get("basisdatum") as Date;
    expect(basisdatum).toBeInstanceOf(Date);
    expect(basisdatum.getFullYear()).toBe(2026);
    expect(basisdatum.getMonth()).toBe(7); // augustus (0-indexed)
    expect(basisdatum.getDate()).toBe(28);
    expect(configMap.get("locatie 1 naam")).toBe("Locatie 1");
    expect(configMap.get("aantal artikels")).toBe(2);

    // --- NIEUWE_ARTIKELEN: structuur behouden; geen van deze artikelen is
    // tijdelijk (allemaal idType "OFFICIEEL"), dus enkel de header, geen rijen.
    const nieuweRows = sheetToRows(workbook.Sheets["NIEUWE_ARTIKELEN"]);
    expect(nieuweRows[0]).toEqual([
      "Tijdelijk ID",
      "Omschrijving",
      "Productgroep",
      "Leverancier",
      "Eenheid",
      "TELPERIODE",
      "Locatie",
      "Aantal",
      "Kostprijs",
      "Opmerking",
      "Officieel artikelnr. na aanmaak",
    ]);
    expect(nieuweRows).toHaveLength(1);
  });

  it("NIEUWE_ARTIKELEN toont tijdelijke artikelen met hun locatie(s) en getelde hoeveelheid (v0.2.1 correctieronde §3C)", async () => {
    const tempArticle = makeArticle("TMP-DAM-0001", {
      officialArticleNumber: null,
      idType: "TIJDELIJK",
      description: "Nieuw gevonden onderdeel",
      supplier: "ACME",
      previousCount: null,
      comment: "Gevonden tijdens telling",
    });
    const entries: CountEntry[] = [
      makeEntry("damme:TMP-DAM-0001", "damme:loc-1", { quantity: 6, counted: true }),
    ];
    const assignments: ArticleLocationAssignment[] = [
      {
        id: "damme:damme:TMP-DAM-0001:damme:loc-1",
        officeId: "damme",
        articleId: "damme:TMP-DAM-0001",
        locationId: "damme:loc-1",
        active: true,
        lastSeenAt: "2026-08-27T10:00:00.000Z",
      },
    ];
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-28T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: [],
    };
    const review = computeSessionReview(session, [tempArticle], office.locations, entries);
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles: [tempArticle],
      assignments,
      ...buildSnapshotInputs(session, [tempArticle], review),
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const rows = sheetToRows(workbook.Sheets["NIEUWE_ARTIKELEN"]);
    const header = rows[0] as string[];
    const col = (name: string) => header.indexOf(name);
    const row = rows.find((r) => r[col("Tijdelijk ID")] === "TMP-DAM-0001")!;
    expect(row[col("Omschrijving")]).toBe("Nieuw gevonden onderdeel");
    expect(row[col("Leverancier")]).toBe("ACME");
    expect(row[col("Locatie")]).toBe("Locatie 1");
    expect(row[col("Aantal")]).toBe(6);
    expect(row[col("Opmerking")]).toBe("Gevonden tijdens telling");
    expect(row[col("Officieel artikelnr. na aanmaak")]).toBeNull();

    // Het tijdelijke artikel moet ook gewoon in ARTIKEL zitten (roundtrip-basis).
    const artikelRows = sheetToRows(workbook.Sheets["ARTIKEL"]);
    const artikelHeader = artikelRows[0] as string[];
    const acol = (name: string) => artikelHeader.indexOf(name);
    expect(artikelRows.some((r) => r[acol("Artikelnr.")] === "TMP-DAM-0001")).toBe(true);
  });

  it("schrijft een expliciete 0-telling als 0, niet als leeg", async () => {
    const article = makeArticle("A1", { previousCount: 5 });
    const entries: CountEntry[] = [makeEntry("damme:A1", "damme:loc-1", { quantity: 0, counted: true })];
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-28T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: ["damme:A1"],
    };
    const review = computeSessionReview(session, [article], office.locations, entries);
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles: [article],
      assignments: [],
      ...buildSnapshotInputs(session, [article], review),
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const { header: headerRow, dataRows } = findHeaderRowAndData(sheetToRows(workbook.Sheets["TELLING"]));
    const header = headerRow as string[];
    const col = (name: string) => header.indexOf(name);
    const row = dataRows[0];
    expect(row[col("LOCATIE 1")]).toBe(0);
    expect(row[col("AANTAL TOTAAL")]).toBe(0);
    expect(row[col("GETELD?")]).toBe("JA");
  });

  it("laat een manueel buiten-scope toegevoegd artikel ook in TELLING verschijnen", async () => {
    const scopeArticle = makeArticle("A1");
    const manualArticle = makeArticle("Q1", { countPeriod: "QUARTERLY", rawCountPeriod: "KWARTAAL" });
    const entries: CountEntry[] = [
      makeEntry("damme:A1", "damme:loc-1", { quantity: 10, counted: true }),
      makeEntry("damme:Q1", "damme:loc-2", {
        quantity: 1,
        counted: true,
        note: "Buiten sessiescope: handmatig toegevoegd tijdens maandtelling.",
      }),
    ];
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-28T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: ["damme:A1"],
    };
    const review = computeSessionReview(session, [scopeArticle, manualArticle], office.locations, entries);
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles: [scopeArticle, manualArticle],
      assignments: [],
      ...buildSnapshotInputs(session, [scopeArticle, manualArticle], review),
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const { header: headerRow, dataRows } = findHeaderRowAndData(sheetToRows(workbook.Sheets["TELLING"]));
    const header = headerRow as string[];
    const col = (name: string) => header.indexOf(name);
    const q1Row = dataRows.find((r) => r[col("Artikelnr.")] === "Q1")!;
    expect(q1Row[col("LOCATIE 2")]).toBe(1);
    expect(q1Row[col("AANTAL TOTAAL")]).toBe(1);
    expect(q1Row[col("GETELD?")]).toBe("JA");
    expect(q1Row[col("Opmerking")]).toBe("Buiten sessiescope: handmatig toegevoegd tijdens maandtelling.");
  });
});

describe("ExcelStockResultExporter — rollend stockarchief", () => {
  it("voegt exact één nieuw, benoemd tellingtabblad toe met een volledige snapshot (incl. OVERGENOMEN)", async () => {
    const monthlyArticle = makeArticle("A1", { previousCount: 10, costPrice: 2 });
    const quarterlyArticle = makeArticle("Q1", {
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
      previousCount: 12,
    });
    const allArticles = [monthlyArticle, quarterlyArticle];
    const entries: CountEntry[] = [makeEntry("damme:A1", "damme:loc-1", { quantity: 7, counted: true })];
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-09-30T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: ["damme:A1"],
    };
    const review = computeSessionReview(session, allArticles, office.locations, entries);
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles,
      assignments: [],
      ...buildSnapshotInputs(session, allArticles, review),
    });

    expect(exported.newHistoricalSheet?.sheetName).toBe("2026-09 Maand");

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    expect(workbook.SheetNames).toContain("2026-09 Maand");
    const rows = sheetToRows(workbook.Sheets["2026-09 Maand"]);
    const header = rows[0] as string[];
    const col = (name: string) => header.indexOf(name);

    const a1Row = rows.find((r) => r[col("Artikelnr.")] === "A1")!;
    expect(a1Row[col("Status telling")]).toBe("GETELD");
    expect(a1Row[col("Nieuwe telling")]).toBe(7);

    const q1Row = rows.find((r) => r[col("Artikelnr.")] === "Q1")!;
    expect(q1Row[col("Status telling")]).toBe("OVERGENOMEN");
    expect(q1Row[col("Nieuwe telling")]).toBe(12); // NOOIT 0
  });

  it("schrijft HISTORIE met de reeds samengevoegde regels", async () => {
    const article = makeArticle("A1", { previousCount: 10, costPrice: 2 });
    const entries: CountEntry[] = [makeEntry("damme:A1", "damme:loc-1", { quantity: 7, counted: true })];
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-09-30T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: ["damme:A1"],
    };
    const review = computeSessionReview(session, [article], office.locations, entries);
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles: [article],
      assignments: [],
      ...buildSnapshotInputs(session, [article], review),
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const rows = sheetToRows(workbook.Sheets["HISTORIE"]);
    const header = rows[0] as string[];
    const col = (name: string) => header.indexOf(name);
    const a1Row = rows.find((r) => r[col("Artikelnr.")] === "A1")!;
    expect(a1Row[col("Tellingnaam")]).toBe("2026-09 Maand");
    expect(a1Row[col("Status telling")]).toBe("GETELD");
    expect(a1Row[col("Totale voorraad")]).toBe(7);
  });

  it("geeft bestaande historische tellingtabs ongewijzigd door", async () => {
    const article = makeArticle("A1", { previousCount: 10, costPrice: 2 });
    const entries: CountEntry[] = [makeEntry("damme:A1", "damme:loc-1", { quantity: 7, counted: true })];
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-09-30T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: ["damme:A1"],
    };
    const review = computeSessionReview(session, [article], office.locations, entries);
    const historicalRows = [["Iets", null], ["Onaangeroerd", 42]];
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles: [article],
      assignments: [],
      snapshot: buildSessionSnapshot(session, [article], review),
      historicalSheets: [{ sheetName: "2026-08 Maand", rows: historicalRows }],
      historyEntries: [],
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    expect(workbook.SheetNames).toContain("2026-08 Maand");
    const rows = sheetToRows(workbook.Sheets["2026-08 Maand"]);
    expect(rows).toEqual(historicalRows);
  });

  it("hergebruikt frozenSnapshotRows in plaats van het tabblad te herberekenen", async () => {
    const article = makeArticle("A1", { previousCount: 999, costPrice: 2 });
    const session: CountSession = {
      id: "session-1",
      officeId: "damme",
      type: "MONTHLY",
      status: "COMPLETED",
      startedAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-09-30T15:00:00.000Z",
      sourceFileName: "test.xlsx",
      sourceBaseDate: "2026-08-27",
      articleIds: [],
    };
    const review = computeSessionReview(session, [article], office.locations, []);
    const frozenRows = [["Bevroren", null], ["Rij", 1]];
    const exported = await new ExcelStockResultExporter().exportResults({
      office,
      session,
      review,
      allArticles: [article],
      assignments: [],
      snapshot: buildSessionSnapshot(session, [article], review),
      historicalSheets: [],
      historyEntries: [],
      frozenSnapshotRows: frozenRows,
    });

    expect(exported.newHistoricalSheet).toBeUndefined(); // niets nieuws te bewaren
    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const rows = sheetToRows(workbook.Sheets["2026-09 Maand"]);
    expect(rows).toEqual(frozenRows);
  });
});
