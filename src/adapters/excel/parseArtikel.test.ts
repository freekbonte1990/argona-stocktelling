import { describe, expect, it } from "vitest";
import { getStockClassification } from "../../domain/stockClassification";
import { ARTIKEL_HEADER_ROW } from "./testWorkbook";
import { parseArtikelSheet, STOCK_CLASSIFICATION_HEADER } from "./parseArtikel";

/**
 * Sprint 2 (Historical Count Analysis) §5/§14: "Voorraadclassificatie" is
 * een OPTIONELE kolom in ARTIKEL — deze tests bewijzen specifiek de
 * backward-compatibele import: een bestand van vóór deze sprint (zonder de
 * kolom) blijft probleemloos importeren met een veilige ACTIVE-default,
 * en een bestand MET de kolom leest de expliciete waarde correct in.
 */

function baseDataRow(articleNumber: string): unknown[] {
  return [articleNumber, articleNumber, "OFFICIEEL", `Artikel ${articleNumber}`, "GROEP", null, "stuk", 5, "MAAND", "ACTIEF", 3, 1];
}

describe("parseArtikelSheet — Voorraadclassificatie (Sprint 2, backward compatible)", () => {
  it("een bestand van vóór deze sprint (kolom ontbreekt volledig) importeert veilig als ACTIVE voor elk artikel", () => {
    const rows: unknown[][] = [[...ARTIKEL_HEADER_ROW], baseDataRow("A1"), baseDataRow("A2")];
    const articles = parseArtikelSheet(rows, "office");
    expect(articles).toHaveLength(2);
    for (const article of articles) {
      expect(getStockClassification(article)).toBe("ACTIVE");
    }
  });

  it("leest een expliciete 'OBSOLETE'-waarde correct in wanneer de kolom aanwezig is", () => {
    const rows: unknown[][] = [
      [...ARTIKEL_HEADER_ROW, STOCK_CLASSIFICATION_HEADER],
      [...baseDataRow("A1"), "OBSOLETE"],
      [...baseDataRow("A2"), "ACTIEF"],
    ];
    const articles = parseArtikelSheet(rows, "office");
    const a1 = articles.find((a) => a.articleNumber === "A1")!;
    const a2 = articles.find((a) => a.articleNumber === "A2")!;
    expect(getStockClassification(a1)).toBe("OBSOLETE");
    expect(getStockClassification(a2)).toBe("ACTIVE");
  });

  it("een onbekende/lege waarde in de kolom valt conservatief terug op ACTIVE (nooit stilzwijgend OBSOLETE)", () => {
    const rows: unknown[][] = [
      [...ARTIKEL_HEADER_ROW, STOCK_CLASSIFICATION_HEADER],
      [...baseDataRow("A1"), ""],
      [...baseDataRow("A2"), "iets onbekends"],
    ];
    const articles = parseArtikelSheet(rows, "office");
    for (const article of articles) {
      expect(getStockClassification(article)).toBe("ACTIVE");
    }
  });

  it("expliciete bronstatus OBSOLETE* zet de INITIËLE classificatie; ACTIEF/NON-ACTIEF/ZIE PANELEN niet", () => {
    const withStatus = (n: string, status: string): unknown[] => {
      const row = baseDataRow(n);
      row[9] = status;
      return row;
    };
    const rows: unknown[][] = [
      [...ARTIKEL_HEADER_ROW],
      withStatus("R", "OBSOLETE - ROOD"),
      withStatus("P", "OBSOLETE - PANEEL"),
      withStatus("O", "OBSOLETE"),
      withStatus("A", "ACTIEF"),
      withStatus("N", "NON-ACTIEF"),
      withStatus("Z", "ZIE PANELEN"),
    ];
    const byNr = new Map(parseArtikelSheet(rows, "office").map((a) => [a.articleNumber, getStockClassification(a)]));
    expect([byNr.get("R"), byNr.get("P"), byNr.get("O")]).toEqual(["OBSOLETE", "OBSOLETE", "OBSOLETE"]);
    expect([byNr.get("A"), byNr.get("N"), byNr.get("Z")]).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
  });

  it("een expliciete kolomwaarde wint van de bronstatus (export-roundtrip van een handmatige keuze)", () => {
    const row = baseDataRow("A1");
    row[9] = "OBSOLETE - ROOD";
    const rows: unknown[][] = [[...ARTIKEL_HEADER_ROW, STOCK_CLASSIFICATION_HEADER], [...row, "ACTIEF"]];
    expect(getStockClassification(parseArtikelSheet(rows, "office")[0])).toBe("ACTIVE");
  });
});
