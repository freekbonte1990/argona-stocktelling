import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLegacyImportPlan } from "../../domain/legacyImport";
import { LEGACY_PERIOD_BY_KEY, REQUIRED_LEGACY_PERIODS } from "../../domain/legacyPeriods";
import { parseLegacyStockDamme, parseLegacyStockLokeren } from "./parseLegacyStock";

/**
 * Sprint 3.3 §3: draait de echte, door Argona aangeleverde historische
 * stockbestanden door de pragmatische legacy-importer heen. Dit is BEWUST
 * geen zuivere unit test met kleine fixtures — de echte bestanden zijn zo
 * inconsistent gestructureerd (zie `parseLegacyStock.ts`s doc-comment) dat
 * enkel de echte data de parser eerlijk test. Faalt deze test doordat het
 * bestand ontbreekt (bv. in een andere sandbox/CI-omgeving zonder deze
 * bestanden), dan wordt de test overgeslagen i.p.v. de hele suite te breken.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../test-fixtures/legacy");
const LOKEREN_FILE = "TGOVL - Stock 01.09.2026 - Telfrequentie.xlsx";
const DAMME_FILE = "TGWVL - Stock 31.08.2026 - Telfrequentie.xlsx";

function loadBuffer(fileName: string): ArrayBuffer | null {
  const filePath = path.join(FIXTURES_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  const nodeBuffer = fs.readFileSync(filePath);
  return nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength) as ArrayBuffer;
}

describe("parseLegacyStockLokeren (echt TGOVL-bestand)", () => {
  const buffer = loadBuffer(LOKEREN_FILE);
  const maybeIt = buffer ? it : it.skip;

  maybeIt("leest alle 7 vereiste periodes uit, met plausibele aantallen/kostprijzen en een correcte preview", () => {
    const rows = parseLegacyStockLokeren(buffer as ArrayBuffer, LOKEREN_FILE);
    expect(rows.length).toBeGreaterThan(1500); // 6 periodes × ~365-420 rijen (DATA) + ~419 (01 09 2026)

    const periodKeys = new Set(rows.map((r) => r.periodKey));
    for (const period of REQUIRED_LEGACY_PERIODS) {
      expect(periodKeys.has(period.key)).toBe(true);
    }

    // Steekproef: elke rij heeft een omschrijving, en de meeste een
    // artikelnummer + positieve kostprijs (spec: oorspronkelijke kostprijs,
    // nooit een afgewaardeerde waarde — hier louter een plausibiliteitscheck,
    // geen exacte waarde, want de bron zelf bevat bekende anomalieën).
    const withArticleNumber = rows.filter((r) => r.articleNumber !== null);
    expect(withArticleNumber.length).toBeGreaterThan(rows.length * 0.9);
    const withPositiveCost = rows.filter((r) => r.originalCostPrice !== null && r.originalCostPrice > 0);
    expect(withPositiveCost.length).toBeGreaterThan(rows.length * 0.8);

    const plan = buildLegacyImportPlan(rows, "lokeren", LEGACY_PERIOD_BY_KEY, []);
    expect(plan.preview.totalRows).toBe(rows.length);
    expect(plan.preview.periods).toHaveLength(7);
    expect(plan.preview.totalOriginalStockValue).toBeGreaterThan(0);
    // Zonder enig huidig artikel (`currentArticles: []`) matcht alles op
    // artikelnummer of komt onopgelost terecht — nooit stilzwijgend verloren.
    expect(plan.preview.totalMatched + plan.preview.totalUnresolved).toBe(rows.length);
  });
});

describe("parseLegacyStockDamme (echt TGWVL-bestand)", () => {
  const buffer = loadBuffer(DAMME_FILE);
  const maybeIt = buffer ? it : it.skip;

  maybeIt("leest alle 7 vereiste periodes uit (incl. de twee C4U-tabbladen voor 2025), met een correcte preview", () => {
    const rows = parseLegacyStockDamme(buffer as ArrayBuffer, DAMME_FILE);
    expect(rows.length).toBeGreaterThan(1500);

    const periodKeys = new Set(rows.map((r) => r.periodKey));
    for (const period of REQUIRED_LEGACY_PERIODS) {
      expect(periodKeys.has(period.key)).toBe(true);
    }

    // C4U-rijen (spec: gebruiker koos expliciet "ja, ook importeren") zitten
    // effectief in de 2025-03-31/2025-06-30 periodes, met hun eigen
    // "C4U"-productgroep-label en zonder artikelnummer.
    const c4uRows = rows.filter((r) => r.sourceProductGroup === "C4U");
    expect(c4uRows.length).toBeGreaterThan(0);
    expect(c4uRows.every((r) => r.articleNumber === null)).toBe(true);
    expect(new Set(c4uRows.map((r) => r.periodKey))).toEqual(new Set(["2025-03-31", "2025-06-30"]));

    const plan = buildLegacyImportPlan(rows, "damme", LEGACY_PERIOD_BY_KEY, []);
    expect(plan.preview.totalRows).toBe(rows.length);
    expect(plan.preview.periods).toHaveLength(7);
    expect(plan.preview.totalOriginalStockValue).toBeGreaterThan(0);
  });

  maybeIt("negeert de gebroken #REF!-vergelijkingskolommen (geen enkele rij heeft een NaN-achtige hoeveelheid/kostprijs)", () => {
    const rows = parseLegacyStockDamme(buffer as ArrayBuffer, DAMME_FILE);
    for (const row of rows) {
      if (row.quantity !== null) expect(Number.isFinite(row.quantity)).toBe(true);
      if (row.originalCostPrice !== null) expect(Number.isFinite(row.originalCostPrice)).toBe(true);
    }
  });
});
