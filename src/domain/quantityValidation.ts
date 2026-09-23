/**
 * Data-integriteit-sprint §6: harde validatie van een ingevoerde hoeveelheid.
 * Toegepast op TWEE plekken (spec: "zowel het inputcomponent als de
 * applicatie-/domeinlaag") — nooit enkel op de UI vertrouwen, want een
 * service kan ook rechtstreeks (bv. vanuit een test, of later eBuddy)
 * aangeroepen worden zonder door een invoercomponent te gaan.
 *
 * Toegestaan: 0 (een volwaardige, geldige telling — zie `CountEntry` in
 * domain/types.ts) en decimalen (sommige eenheden, bv. meter/kg, zijn geen
 * gehele getallen). NOOIT toegestaan: negatieve getallen (een fysieke
 * hoeveelheid kan nooit negatief zijn), `NaN`, en `Infinity`/`-Infinity` —
 * geen van die laatste drie is een zinvol resultaat van een telling.
 */
export function isValidQuantity(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Gegooid door de applicatielaag (nooit enkel client-side) zodra een ongeldige hoeveelheid een service bereikt. */
export class InvalidQuantityError extends Error {
  readonly value: number;

  constructor(value: number) {
    super(`Ongeldige hoeveelheid (${value}) — moet een eindig getal groter dan of gelijk aan 0 zijn.`);
    this.name = "InvalidQuantityError";
    this.value = value;
  }
}

/** Gooit `InvalidQuantityError` tenzij `isValidQuantity(value)`. Zie hierboven voor de precieze regels. */
export function assertValidQuantity(value: number): void {
  if (!isValidQuantity(value)) {
    throw new InvalidQuantityError(value);
  }
}
