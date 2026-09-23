import { describe, expect, it } from "vitest";
import { DEFAULT_DEVIATION_THRESHOLDS, isExtremeDeviation } from "./deviationWarning";

/**
 * Data-integriteit-sprint §7: "Grote afwijking" — een ZACHTE waarschuwing
 * (nooit een harde blokkering) zodra minstens één van drie onafhankelijke
 * drempels overschreden wordt: absoluut aantal, percentage van de vorige
 * telling, of euro-waarde.
 */
describe("deviationWarning.ts", () => {
  it("geen vorige telling gekend -> nooit extreem (geen fictieve vergelijkingsbasis)", () => {
    expect(
      isExtremeDeviation({ previousCount: null, newQuantity: 100000, costPrice: 50 }),
    ).toBe(false);
  });

  it("klein verschil, ruim onder alle drempels -> geen waarschuwing", () => {
    expect(
      isExtremeDeviation({ previousCount: 10, newQuantity: 12, costPrice: 1 }),
    ).toBe(false);
  });

  it("absoluut aantal-drempel: een verschil >= de drempel triggert, ongeacht percentage/waarde", () => {
    const thresholds = { absoluteQuantity: 50, percentOfPrevious: 10, euroValue: 100000 };
    expect(
      isExtremeDeviation({ previousCount: 1000, newQuantity: 1051, costPrice: 0 }, thresholds),
    ).toBe(true);
    expect(
      isExtremeDeviation({ previousCount: 1000, newQuantity: 1049, costPrice: 0 }, thresholds),
    ).toBe(false);
  });

  it("percentage-drempel: een halvering/verdubbeling t.o.v. de vorige telling triggert", () => {
    const thresholds = { absoluteQuantity: 100000, percentOfPrevious: 0.5, euroValue: 100000 };
    // Verschil van 6 t.o.v. 10 = 60% >= 50%.
    expect(isExtremeDeviation({ previousCount: 10, newQuantity: 16, costPrice: 0 }, thresholds)).toBe(
      true,
    );
    // Verschil van 3 t.o.v. 10 = 30% < 50%.
    expect(isExtremeDeviation({ previousCount: 10, newQuantity: 13, costPrice: 0 }, thresholds)).toBe(
      false,
    );
  });

  it("een vorige telling van 0 slaat de percentage-check over (deling door 0) maar blijft bruikbaar via de andere drempels", () => {
    const thresholds = { absoluteQuantity: 5, percentOfPrevious: 0.5, euroValue: 100000 };
    expect(isExtremeDeviation({ previousCount: 0, newQuantity: 6, costPrice: 0 }, thresholds)).toBe(
      true, // via de absolute drempel
    );
    expect(isExtremeDeviation({ previousCount: 0, newQuantity: 2, costPrice: 0 }, thresholds)).toBe(
      false,
    );
  });

  it("euro-waarde-drempel: een klein aantal met hoge kostprijs kan toch triggeren", () => {
    const thresholds = { absoluteQuantity: 1000, percentOfPrevious: 10, euroValue: 500 };
    // Verschil van 6 stuks * kostprijs 100 = €600 >= €500.
    expect(
      isExtremeDeviation({ previousCount: 10, newQuantity: 16, costPrice: 100 }, thresholds),
    ).toBe(true);
  });

  it("een bevestigde extreme waarde (spec: 'moet daarna normaal opslaan') levert nog steeds hetzelfde, deterministische resultaat op — geen verborgen state", () => {
    const input = { previousCount: 10, newQuantity: 1000, costPrice: 1 };
    expect(isExtremeDeviation(input)).toBe(isExtremeDeviation(input));
  });

  it("standaarddrempels zijn centraal, benoemd en niet willekeurig 0", () => {
    expect(DEFAULT_DEVIATION_THRESHOLDS.absoluteQuantity).toBeGreaterThan(0);
    expect(DEFAULT_DEVIATION_THRESHOLDS.percentOfPrevious).toBeGreaterThan(0);
    expect(DEFAULT_DEVIATION_THRESHOLDS.euroValue).toBeGreaterThan(0);
  });
});
