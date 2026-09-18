import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExcelStockSourceFromBuffer } from "./ExcelStockSource";

/**
 * Integratietests op de drie ECHTE, door Argona aangeleverde Excelbestanden
 * (map `test-fixtures/`, buiten `src/` gehouden zodat ze niet meegepakt
 * worden in de productiebundel).
 *
 * Belangrijk (spec v0.1.1 §1): de verwachte aantallen/velden hieronder zijn
 * bewust ALLEEN in dit testbestand hardgecodeerd, nooit in de productiecode
 * onder `src/domain` of `src/adapters` — die blijven het bestand gewoon
 * inlezen zonder te weten wat er "hoort" uit te komen.
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

describe("Echte Excel-fixtures — Antwerpen", () => {
  const buffer = loadFixtureBuffer("Stocktelling_Antwerpen_standaard.xlsx");
  const source = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Antwerpen_standaard.xlsx");

  it("herkent het kantoor en de basisdatum correct", async () => {
    const office = await source.loadOffice();
    expect(office.name).toBe("Antwerpen");
    // TELLING/CONFIG tonen "28-08-2026" als basisdatum (zie sheet CONFIG).
    expect(office.baseDate).toBe("2026-08-28");
    expect(office.locations).toHaveLength(5);
  });

  it("telt exact het verwachte aantal artikelen", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    expect(articles).toHaveLength(1357);
  });

  it("valideert de artikelvelden van het eerste artikel (ECO00001)", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    const article = articles.find((a) => a.articleNumber === "ECO00001");
    expect(article).toBeDefined();
    expect(article?.officialArticleNumber).toBe("ECO00001");
    expect(article?.idType).toBe("OFFICIEEL");
    expect(article?.description).toBe("Automaat 4P 63A C");
    expect(article?.productGroup).toBe("Materiaal AC");
    expect(article?.supplier).toBeNull();
    expect(article?.unit).toBe("STUKS");
    expect(article?.costPrice).toBeCloseTo(48.16);
    expect(article?.rawCountPeriod).toBe("MAAND");
    expect(article?.countPeriod).toBe("MONTHLY");
    expect(article?.rawStatus).toBe("ACTIEF");
    expect(article?.status).toBe("ACTIVE");
    expect(article?.previousCount).toBe(8);
  });
});

describe("Echte Excel-fixtures — Lokeren", () => {
  const buffer = loadFixtureBuffer("Stocktelling_Lokeren_standaard.xlsx");
  const source = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Lokeren_standaard.xlsx");

  it("herkent het kantoor en de basisdatum correct", async () => {
    const office = await source.loadOffice();
    expect(office.name).toBe("Lokeren");
    expect(office.baseDate).toBe("2026-09-01");
  });

  it("telt exact het verwachte aantal artikelen", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    expect(articles).toHaveLength(419);
  });

  it("valideert de artikelvelden van het eerste artikel (BATT0502005)", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    const article = articles.find((a) => a.articleNumber === "BATT0502005");
    expect(article).toBeDefined();
    expect(article?.description).toBe("Alpha-ESS Storion Grid CT-klem");
    expect(article?.productGroup).toBe("Batterijen");
    expect(article?.supplier).toBeNull();
    expect(article?.unit).toBeNull();
    expect(article?.costPrice).toBeCloseTo(22.56);
    expect(article?.countPeriod).toBe("MONTHLY");
    expect(article?.status).toBe("ACTIVE");
    expect(article?.previousCount).toBe(19);
  });
});

describe("Echte Excel-fixtures — Damme", () => {
  const buffer = loadFixtureBuffer("Stocktelling_Damme_standaard.xlsx");
  const source = createExcelStockSourceFromBuffer(buffer, "Stocktelling_Damme_standaard.xlsx");

  it("herkent het kantoor en de basisdatum correct", async () => {
    const office = await source.loadOffice();
    expect(office.name).toBe("Damme");
    expect(office.baseDate).toBe("2026-09-01");
  });

  it("telt exact het verwachte aantal artikelen", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    expect(articles).toHaveLength(527);
  });

  it("importeert tijdelijke artikelnummers (TMP-DAM-xxxx) probleemloos", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    const tempArticles = articles.filter((a) => a.articleNumber.startsWith("TMP-DAM-"));
    expect(tempArticles.length).toBeGreaterThan(0);

    const first = articles.find((a) => a.articleNumber === "TMP-DAM-0001");
    expect(first).toBeDefined();
    expect(first?.id).toBe(`${office.id}:TMP-DAM-0001`);
    expect(first?.idType).toBe("TIJDELIJK");
    expect(first?.officialArticleNumber).toBeNull();
    expect(first?.description).toBe("SOEPEL INSTALLATIEDRAAD H07V-K ECA 10 MM2Blauw");
    expect(first?.productGroup).toBe("LAADPALEN");
    expect(first?.rawCountPeriod).toBe("KWARTAAL");
    expect(first?.countPeriod).toBe("QUARTERLY");
    expect(first?.costPrice).toBeCloseTo(2.13);
    expect(first?.previousCount).toBe(50);
  });

  it("valt terug op TO_BE_DETERMINED voor 'NOG TE BEPALEN' zonder het artikel te weigeren", async () => {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    const article = articles.find((a) => a.articleNumber === "TMP-DAM-0003");
    expect(article).toBeDefined();
    expect(article?.rawCountPeriod).toBe("NOG TE BEPALEN");
    expect(article?.countPeriod).toBe("TO_BE_DETERMINED");
    expect(article?.status).toBe("ACTIVE");
  });
});
