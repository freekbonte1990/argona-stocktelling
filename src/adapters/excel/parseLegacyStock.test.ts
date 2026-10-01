import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { ExcelValidationError } from "./excelErrors";
import { parseLegacyStockDamme, parseLegacyStockLokeren } from "./parseLegacyStock";
import { buildTestWorkbookBuffer, defaultConfigRows, defaultTellingRows, ARTIKEL_HEADER_ROW } from "./testWorkbook";

/**
 * Vervolg ("ik zie dit als ik eerst de oude data inlaadt, en daarna de
 * recente"): bevestigde repro — wie per ongeluk het gewone/recente
 * exportbestand van de app (CONFIG/ARTIKEL/TELLING) kiest in de
 * legacy-importsectie, kreeg voorheen stilzwijgend een "geldig maar leeg"
 * preview-rapport (0 rijen, 0 periodes, geen foutmelding), want geen van de
 * hardgecodeerde tabbladnamen (bv. "DATA"/"Stock 31.03.2025") matcht dan ook
 * maar één sheet in dat bestand. Deze tests dekken de nieuwe bewaking
 * (`assertRecognizableLegacyWorkbook`) die dat geval nu expliciet laat falen,
 * én bevestigen dat het legitieme "sommige periode-tabbladen ontbreken nog
 * gewoon"-geval (bv. geen C4U-tabblad voor latere periodes) onveranderd
 * blijft werken.
 */

function buildRegularAppExportBuffer(): ArrayBuffer {
  // Hetzelfde workbookformaat als een gewoon/recent app-exportbestand
  // (CONFIG/ARTIKEL/TELLING) — exact wat een gebruiker per ongeluk zou
  // kunnen kiezen i.p.v. het originele historische Excelbestand.
  return buildTestWorkbookBuffer({
    configRows: defaultConfigRows(),
    artikelRows: [ARTIKEL_HEADER_ROW],
    tellingRows: defaultTellingRows(),
  });
}

describe("parseLegacyStockLokeren — bewaking tegen een volledig verkeerd bestand", () => {
  it("gooit een duidelijke ExcelValidationError wanneer geen enkel verwacht tabblad aanwezig is (bv. het gewone app-exportbestand)", () => {
    const buffer = buildRegularAppExportBuffer();
    expect(() => parseLegacyStockLokeren(buffer, "TGOVL - per ongeluk recent bestand.xlsx")).toThrow(
      ExcelValidationError,
    );
    try {
      parseLegacyStockLokeren(buffer, "TGOVL - per ongeluk recent bestand.xlsx");
      expect.fail("had moeten gooien");
    } catch (error) {
      expect(error).toBeInstanceOf(ExcelValidationError);
      const message = (error as Error).message;
      expect(message).toContain("TGOVL - per ongeluk recent bestand.xlsx");
      // Toont welke tabbladen WEL aanwezig zijn, als hulp bij het zoeken.
      expect(message).toContain("CONFIG");
    }
  });

  it("blijft werken wanneer slechts één van de twee verwachte tabbladen aanwezig is (legitiem gedeeltelijk bestand)", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["DATUM", "cProducttype", "OBSOLETE?", "cProduct", "cArticlenumber", "cPurchaseprice", "Quantity Total"],
        ["Q1 2025", "Type A", "NEE", "Product X", "12345", 10.5, 3],
      ]),
      "DATA",
    );
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const rows = parseLegacyStockLokeren(buffer, "TGOVL - gedeeltelijk.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ periodKey: "2025-03-31", description: "Product X", articleNumber: "12345" });
  });
});

describe("parseLegacyStockDamme — bewaking tegen een volledig verkeerd bestand", () => {
  it("gooit een duidelijke ExcelValidationError wanneer geen enkel verwacht tabblad aanwezig is (bv. het gewone app-exportbestand)", () => {
    const buffer = buildRegularAppExportBuffer();
    expect(() => parseLegacyStockDamme(buffer, "TGWVL - per ongeluk recent bestand.xlsx")).toThrow(
      ExcelValidationError,
    );
  });

  it("blijft werken wanneer slechts één van de negen verwachte tabbladen aanwezig is (legitiem gedeeltelijk bestand)", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Producttype", "Product", "Artikelnummer", "Aankoopprijs", "Aantal"],
        ["Type A", "Product X", "12345", 10.5, 3],
      ]),
      "Stock 31.03.2025",
    );
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const rows = parseLegacyStockDamme(buffer, "TGWVL - gedeeltelijk.xlsx");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ periodKey: "2025-03-31", description: "Product X", articleNumber: "12345" });
  });
});
