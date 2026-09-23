import { describe, expect, it } from "vitest";
import { InvalidQuantityError, assertValidQuantity, isValidQuantity } from "./quantityValidation";

/**
 * Data-integriteit-sprint §6: harde validatie van een ingevoerde hoeveelheid
 * — toegestaan: 0 en decimalen; nooit toegestaan: negatief, NaN, Infinity.
 */
describe("quantityValidation.ts", () => {
  it("aanvaardt 0 als geldige hoeveelheid", () => {
    expect(isValidQuantity(0)).toBe(true);
  });

  it("aanvaardt decimalen (bv. 2.5 kg/meter)", () => {
    expect(isValidQuantity(2.5)).toBe(true);
    expect(isValidQuantity(0.1)).toBe(true);
  });

  it("aanvaardt gewone positieve gehele getallen", () => {
    expect(isValidQuantity(1000)).toBe(true);
  });

  it("weigert negatieve getallen", () => {
    expect(isValidQuantity(-1)).toBe(false);
    expect(isValidQuantity(-0.5)).toBe(false);
  });

  it("weigert NaN", () => {
    expect(isValidQuantity(Number.NaN)).toBe(false);
  });

  it("weigert Infinity en -Infinity", () => {
    expect(isValidQuantity(Infinity)).toBe(false);
    expect(isValidQuantity(-Infinity)).toBe(false);
  });

  it("assertValidQuantity gooit InvalidQuantityError voor een ongeldige waarde", () => {
    expect(() => assertValidQuantity(-5)).toThrow(InvalidQuantityError);
    expect(() => assertValidQuantity(Number.NaN)).toThrow(InvalidQuantityError);
    expect(() => assertValidQuantity(Infinity)).toThrow(InvalidQuantityError);
  });

  it("assertValidQuantity gooit niets voor 0 of een geldig getal", () => {
    expect(() => assertValidQuantity(0)).not.toThrow();
    expect(() => assertValidQuantity(3.5)).not.toThrow();
  });
});
