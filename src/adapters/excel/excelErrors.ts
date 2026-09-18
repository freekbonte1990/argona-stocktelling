/**
 * Fout bij het importeren/valideren van een Excelbestand.
 * `message` is altijd een begrijpelijke Nederlandstalige tekst zonder
 * technische details — deze mag rechtstreeks aan de gebruiker getoond worden.
 */
export class ExcelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExcelValidationError";
  }
}
