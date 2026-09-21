import { ExcelValidationError } from "./excelErrors";
import { toIsoDateString } from "./excelValues";

export const CONFIG_SHEET_NAME = "CONFIG";

const LABEL_OFFICE = "kantoor";
const LABEL_BASE_DATE = "basisdatum";
const locationNameLabel = (n: number) => `locatie ${n} naam`;
const locationActiveLabel = (n: number) => `locatie ${n} actief`;

/** Veiligheidsgrens tegen een onbegrensde CONFIG-sheet — ruim boven elk realistisch aantal locaties. */
const MAX_LOCATIONS = 200;

export interface ParsedConfigLocation {
  /** Ruwe naam zoals in CONFIG; leeg/null als niet ingevuld (valt terug op "Locatie N"). */
  name: string | null;
  /**
   * "Locatie N actief" — ontbreekt dit label (bv. een bestand van vóór
   * v0.2.1), dan is de locatie actief. De positie N zelf is de volgorde
   * (spec v0.2.1 §1: "CONFIG bewaart naam, volgorde en actieve status" —
   * volgorde is hier bewust de N-positie zelf, geen apart label).
   */
  active: boolean;
}

export interface ParsedConfig {
  officeName: string;
  baseDate: string | null;
  /** Dynamische lijst locaties (v0.2.1: geen vaste 5 meer), in volgorde 1..N. */
  locations: ParsedConfigLocation[];
}

/**
 * CONFIG is geen tabel met kolomheaders, maar een label/waarde-blad
 * ("Kantoor" | Antwerpen, "Basisdatum" | ..., enz.). We zoeken elke rij het
 * eerste niet-lege cel als label en de eerstvolgende niet-lege cel erna als
 * waarde — ook hier dus op NAAM gezocht, niet op een vaste cel-referentie.
 */
export function parseConfigSheet(rows: unknown[][]): ParsedConfig {
  const values = new Map<string, unknown>();

  for (const row of rows) {
    if (!row) continue;
    const labelIndex = row.findIndex((cell) => !isBlankCell(cell));
    if (labelIndex === -1) continue;
    const label = String(row[labelIndex]).trim().toLowerCase();

    let valueIndex = -1;
    for (let i = labelIndex + 1; i < row.length; i++) {
      if (!isBlankCell(row[i])) {
        valueIndex = i;
        break;
      }
    }
    // Label registreren zelfs met een lege waarde (bv. "Locatie 2 naam" met
    // niets ingevuld) — anders lijkt het alsof het label niet bestaat, en
    // stopt het dynamisch aantal locaties tellen te vroeg (zie §1).
    values.set(label, valueIndex === -1 ? null : row[valueIndex]);
  }

  const officeNameRaw = values.get(LABEL_OFFICE);
  const officeName = officeNameRaw !== undefined && officeNameRaw !== null ? String(officeNameRaw).trim() : "";
  if (!officeName) {
    throw new ExcelValidationError(`Veld "Kantoor" ontbreekt in sheet CONFIG.`);
  }

  const baseDate = toIsoDateString(values.get(LABEL_BASE_DATE) ?? null);

  // Dynamisch aantal locaties (v0.2.1 §1): lees "Locatie N naam"/"Locatie N
  // actief" op zolang minstens één van de twee labels bestaat voor die N —
  // zo blijven oude bestanden met precies 5 vaste locaties (geen "actief"-
  // label) exact zo werken als voorheen, en kan een export met bv. 3 of 7
  // locaties er evengoed weer probleemloos ingelezen worden.
  const locations: ParsedConfigLocation[] = [];
  for (let n = 1; n <= MAX_LOCATIONS; n++) {
    const hasName = values.has(locationNameLabel(n));
    const hasActive = values.has(locationActiveLabel(n));
    if (!hasName && !hasActive) break;

    const rawName = values.get(locationNameLabel(n));
    const name =
      rawName !== undefined && rawName !== null && String(rawName).trim() !== ""
        ? String(rawName).trim()
        : null;

    const rawActive = values.get(locationActiveLabel(n));
    const active = rawActive === undefined || rawActive === null ? true : parseActiveFlag(rawActive);

    locations.push({ name, active });
  }

  return { officeName, baseDate, locations };
}

function parseActiveFlag(raw: unknown): boolean {
  const text = String(raw).trim().toLowerCase();
  return text !== "nee" && text !== "no" && text !== "false" && text !== "0";
}

function isBlankCell(cell: unknown): boolean {
  return cell === null || cell === undefined || String(cell).trim() === "";
}
