import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import { computeSessionReview } from "../../domain/review";
import type { Article, CountEntry, CountSession, Office } from "../../domain/types";

const office: Office = {
  id: "damme",
  name: "Damme",
  baseDate: "2026-08-28",
  locations: [1, 2, 3, 4, 5].map((n) => ({
    id: `damme:loc-${n}`,
    officeId: "damme",
    number: n as 1 | 2 | 3 | 4 | 5,
    name: `Locatie ${n}`,
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
    ...overrides,
  };
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];
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
    const exported = await exporter.exportResults({ office, session, review, allArticles });

    expect(exported.fileName).toBe("2026-08-28 - Stocktelling Damme.xlsx");

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    expect(workbook.SheetNames).toEqual(
      expect.arrayContaining(["TELLING", "ARTIKEL", "CONFIG", "NIEUWE_ARTIKELEN"]),
    );

    // --- TELLING ---
    const tellingRows = sheetToRows(workbook.Sheets["TELLING"]);
    const tellingHeader = tellingRows[0] as string[];
    const col = (name: string) => tellingHeader.indexOf(name);
    const a1Row = tellingRows.find((r) => r[col("Artikelnr.")] === "A1")!;
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
    const q1Row = tellingRows.find((r) => r[col("Artikelnr.")] === "Q1")!;
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

    // --- NIEUWE_ARTIKELEN: structuur behouden, geen data (geen wizard deze sprint) ---
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
    expect(nieuweRows[1][0]).toBe("NEW-DAM-0001");
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
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const rows = sheetToRows(workbook.Sheets["TELLING"]);
    const header = rows[0] as string[];
    const col = (name: string) => header.indexOf(name);
    const row = rows[1];
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
    });

    const workbook = XLSX.read(exported.data, { type: "array", cellDates: true });
    const rows = sheetToRows(workbook.Sheets["TELLING"]);
    const header = rows[0] as string[];
    const col = (name: string) => header.indexOf(name);
    const q1Row = rows.find((r) => r[col("Artikelnr.")] === "Q1")!;
    expect(q1Row[col("LOCATIE 2")]).toBe(1);
    expect(q1Row[col("AANTAL TOTAAL")]).toBe(1);
    expect(q1Row[col("GETELD?")]).toBe("JA");
    expect(q1Row[col("Opmerking")]).toBe("Buiten sessiescope: handmatig toegevoegd tijdens maandtelling.");
  });
});
