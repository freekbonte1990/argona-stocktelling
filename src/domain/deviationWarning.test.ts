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
    const thresholds = {
      absoluteQuantity: 50,
      percentOfPrevious: 10,
      euroValue: 100000,
      minPreviousCountForPercent: 0,
    };
    expect(
      isExtremeDeviation({ previousCount: 1000, newQuantity: 1051, costPrice: 0 }, thresholds),
    ).toBe(true);
    expect(
      isExtremeDeviation({ previousCount: 1000, newQuantity: 1049, costPrice: 0 }, thresholds),
    ).toBe(false);
  });

  it("percentage-drempel: een halvering/verdubbeling t.o.v. de vorige telling triggert (bij een vorige telling boven het minimum)", () => {
    const thresholds = {
      absoluteQuantity: 100000,
      percentOfPrevious: 0.5,
      euroValue: 100000,
      minPreviousCountForPercent: 0,
    };
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
    const thresholds = {
      absoluteQuantity: 5,
      percentOfPrevious: 0.5,
      euroValue: 100000,
      minPreviousCountForPercent: 0,
    };
    expect(isExtremeDeviation({ previousCount: 0, newQuantity: 6, costPrice: 0 }, thresholds)).toBe(
      true, // via de absolute drempel
    );
    expect(isExtremeDeviation({ previousCount: 0, newQuantity: 2, costPrice: 0 }, thresholds)).toBe(
      false,
    );
  });

  it("euro-waarde-drempel: een klein aantal met hoge kostprijs kan toch triggeren", () => {
    const thresholds = {
      absoluteQuantity: 1000,
      percentOfPrevious: 10,
      euroValue: 500,
      minPreviousCountForPercent: 0,
    };
    // Verschil van 6 stuks * kostprijs 100 = €600 >= €500.
    expect(
      isExtremeDeviation({ previousCount: 10, newQuantity: 16, costPrice: 100 }, thresholds),
    ).toBe(true);
  });

  /**
   * Aanvulling (feedback: "als je van 1 naar 2 gaat is dat 100% verschil"):
   * bij een lage vorige telling betekent zelfs een verschil van 1 stuk al
   * een enorm percentage — dat zegt niets over of het een tikfout is. De
   * percentage-drempel telt daarom pas mee vanaf `minPreviousCountForPercent`;
   * daaronder blijft enkel de absolute-aantal- en euro-drempel gelden.
   */
  it("percentage-drempel telt niet mee onder minPreviousCountForPercent, ook al is het procentuele verschil enorm", () => {
    const thresholds = {
      absoluteQuantity: 1000,
      percentOfPrevious: 0.5,
      euroValue: 100000,
      minPreviousCountForPercent: 10,
    };
    // 1 -> 2 is 100% verschil, maar de vorige telling (1) ligt onder het minimum (10).
    expect(isExtremeDeviation({ previousCount: 1, newQuantity: 2, costPrice: 0 }, thresholds)).toBe(
      false,
    );
    // 2 -> 1 (50% verschil) evenmin.
    expect(isExtremeDeviation({ previousCount: 2, newQuantity: 1, costPrice: 0 }, thresholds)).toBe(
      false,
    );
    // Vanaf een vorige telling van 10 (== het minimum) telt het percentage weer gewoon mee.
    expect(isExtremeDeviation({ previousCount: 10, newQuantity: 16, costPrice: 0 }, thresholds)).toBe(
      true, // 60% >= 50%
    );
  });

  it("standaarddrempels: €2.000 vangt een verschil van één duur artikel niet meer te snel op", () => {
    // Verschil van 1 stuk * kostprijs €800 = €800 < €2.000 (voorheen: >= €500, dus wél getriggerd).
    expect(
      isExtremeDeviation({ previousCount: 20, newQuantity: 21, costPrice: 800 }),
    ).toBe(false);
    // Verschil van 3 stuks * kostprijs €800 = €2.400 >= €2.000.
    expect(
      isExtremeDeviation({ previousCount: 20, newQuantity: 23, costPrice: 800 }),
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
    expect(DEFAULT_DEVIATION_THRESHOLDS.minPreviousCountForPercent).toBeGreaterThan(0);
  });
});
