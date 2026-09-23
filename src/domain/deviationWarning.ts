/**
 * Data-integriteit-sprint §7: een ZACHTE waarschuwing (bevestigingsdialoog,
 * geen harde blokkering zoals `quantityValidation.ts`) wanneer een nieuw
 * ingevoerde hoeveelheid extreem afwijkt van de vorige (fysieke) telling —
 * "Grote afwijking". Bedoeld om overduidelijke tik-/eenheidsfouten (bv. 1000
 * i.p.v. 100, of een verkeerd geplaatste komma) op te vangen vóór ze worden
 * opgeslagen, zonder een oprecht grote, bewuste correctie te blokkeren: de
 * gebruiker kan altijd expliciet bevestigen.
 *
 * Drie onafhankelijke, elk voor zich voldoende drempels (spec: "mag niet
 * stilzwijgend willekeurig zijn — documenteer zinvolle standaardwaarden"):
 * een GROTE afwijking op ÉÉN van deze assen (absoluut aantal, percentage van
 * de vorige telling, of euro-waarde) is al genoeg om te waarschuwen. Enkel
 * artikelen mét een gekende vorige telling worden gecontroleerd — een artikel
 * zonder vorige telling (nieuw, of nog nooit fysiek geteld) heeft geen
 * zinvolle basis om "extreem" tegen af te zetten (nooit een fictieve 0 als
 * vergelijkingsbasis, zelfde kernregel als de rest van de app).
 */
export interface DeviationThresholds {
  /** Absoluut aantal stuks verschil (ongeacht percentage/waarde) dat al een waarschuwing verdient. */
  absoluteQuantity: number;
  /** Fractie (0-1) van de vorige telling — bv. 0.5 = 50% afwijking. */
  percentOfPrevious: number;
  /** Euro-waarde van het verschil (|verschil aantal| × kostprijs) die al een waarschuwing verdient. */
  euroValue: number;
}

/**
 * Standaardwaarden (bewust gedocumenteerd, geen willekeurige getallen):
 *   - 50 stuks: ruim boven een typische handmatige teltolerantie, maar laag
 *     genoeg om een tikfout (bv. "150" i.p.v. "15") te vangen.
 *   - 50% t.o.v. de vorige telling: een halvering of verdubbeling van de
 *     voorraad is voor de meeste producttypes ongewoon genoeg om een tweede
 *     blik te verdienen.
 *   - €500: een correctie die het kantoor financieel merkbaar raakt.
 * Centraal hier gedefinieerd (spec: "centraal configureerbaar") — één plek
 * om aan te passen, geen verspreide magic numbers doorheen de UI.
 */
export const DEFAULT_DEVIATION_THRESHOLDS: DeviationThresholds = {
  absoluteQuantity: 50,
  percentOfPrevious: 0.5,
  euroValue: 500,
};

export interface DeviationCheckInput {
  previousCount: number | null;
  newQuantity: number;
  costPrice: number | null;
}

/**
 * True zodra minstens één van de drie drempels overschreden wordt. Puur een
 * WAARSCHUWING — de aanroeper (UI) beslist zelf wat ermee te doen (spec: een
 * bevestigde extreme waarde moet daarna gewoon normaal opslaan).
 */
export function isExtremeDeviation(
  input: DeviationCheckInput,
  thresholds: DeviationThresholds = DEFAULT_DEVIATION_THRESHOLDS,
): boolean {
  const { previousCount, newQuantity, costPrice } = input;
  if (previousCount === null) return false;

  const diffQuantity = Math.abs(newQuantity - previousCount);
  if (diffQuantity >= thresholds.absoluteQuantity) return true;

  if (previousCount !== 0 && diffQuantity / Math.abs(previousCount) >= thresholds.percentOfPrevious) {
    return true;
  }

  if (costPrice !== null && diffQuantity * costPrice >= thresholds.euroValue) {
    return true;
  }

  return false;
}
