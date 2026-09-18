import { describe, expect, it } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";
import { ExcelValidationError } from "./excelErrors";
import {
  ARTIKEL_HEADER_ROW,
  buildTestWorkbookBuffer,
  defaultConfigRows,
  defaultTellingRows,
  type TestWorkbookOptions,
} from "./testWorkbook";

function baseOptions(overrides: Partial<TestWorkbookOptions> = {}): TestWorkbookOptions {
  return {
    configRows: defaultConfigRows(),
    tellingRows: defaultTellingRows(),
    artikelRows: [
      ARTIKEL_HEADER_ROW,
      ["ART-1", null, "OFFICIEEL", "Fiets bel", "Accessoires", "Leverancier BV", "stuk", 4.5, "MAAND", "ACTIEF", 10, 15],
      ["TMP-DAM-0001", null, "TIJDELIJK", "Nieuw artikel zonder nummer", "Onderdelen", "Leverancier BV", "stuk", 2, "KWARTAAL", "ACTIEF", 0, 16],
    ],
    ...overrides,
  };
}

describe("createExcelStockSourceFromBuffer — happy path", () => {
  it("leest kantoor, locaties en artikelen correct in", async () => {
    const buffer = buildTestWorkbookBuffer(baseOptions());
    const source = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Antwerpen_standaard.xlsx");
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);

    expect(office.name).toBe("Antwerpen");
    expect(office.baseDate).toBe("2026-09-01");
    expect(office.locations).toHaveLength(5);
    expect(office.locations[0].name).toBe("Magazijn");
    // Lege locatienamen vallen terug op "Locatie N"
    expect(office.locations[1].name).toBe("Locatie 2");

    expect(articles).toHaveLength(2);
  });

  it("accepteert tijdelijke artikelnummers zoals TMP-DAM-0001", async () => {
    const buffer = buildTestWorkbookBuffer(baseOptions());
    const source = createExcelStockSourceFromBuffer(buffer, "test.xlsx");
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    const temp = articles.find((a) => a.articleNumber === "TMP-DAM-0001");
    expect(temp).toBeDefined();
    expect(temp?.idType).toBe("TIJDELIJK");
  });
});

describe("createExcelStockSourceFromBuffer — validatie met begrijpelijke fouten", () => {
  it("geeft een duidelijke fout wanneer een sheet ontbreekt", () => {
    const workbook = baseOptions();
    const buffer = buildTestWorkbookBuffer({
      ...workbook,
      sheetNames: { artikel: "ARTIKELEN_TYPO" },
    });
    expect(() => createExcelStockSourceFromBuffer(buffer, "test.xlsx")).toThrow(ExcelValidationError);
    try {
      createExcelStockSourceFromBuffer(buffer, "test.xlsx");
    } catch (error) {
      expect((error as Error).message).toContain('Sheet "ARTIKEL" ontbreekt');
    }
  });

  it("geeft een duidelijke fout wanneer een verplichte kolom ontbreekt in ARTIKEL", () => {
    const rowsWithoutStatus = [
      ARTIKEL_HEADER_ROW.filter((h) => h !== "Artikelstatus"),
      ["ART-1", null, "OFFICIEEL", "Iets", "Groep", "Lev", "stuk", 1, "MAAND", 10, 1],
    ];
    const buffer = buildTestWorkbookBuffer(baseOptions({ artikelRows: rowsWithoutStatus }));
    expect(() => createExcelStockSourceFromBuffer(buffer, "test.xlsx")).toThrow(ExcelValidationError);
  });

  it("geeft een duidelijke fout wanneer Artikelnr. leeg is op een rij", () => {
    const rows = [
      ARTIKEL_HEADER_ROW,
      [null, null, null, "Iets zonder nummer", "Groep", "Lev", "stuk", 1, "MAAND", "ACTIEF", 0, 5],
    ];
    const buffer = buildTestWorkbookBuffer(baseOptions({ artikelRows: rows }));
    expect(() => createExcelStockSourceFromBuffer(buffer, "test.xlsx")).toThrow(ExcelValidationError);
  });

  it("geeft een duidelijke fout wanneer veld Kantoor ontbreekt in CONFIG", () => {
    const buffer = buildTestWorkbookBuffer(
      baseOptions({ configRows: [["Basisdatum", "2026-01-01"]] }),
    );
    expect(() => createExcelStockSourceFromBuffer(buffer, "test.xlsx")).toThrow(ExcelValidationError);
  });
});
