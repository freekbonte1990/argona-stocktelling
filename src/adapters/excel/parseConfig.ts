import { ExcelValidationError } from "./excelErrors";
import { toIsoDateString } from "./excelValues";

export const CONFIG_SHEET_NAME = "CONFIG";

const LABEL_OFFICE = "kantoor";
const LABEL_BASE_DATE = "basisdatum";
const locationLabel = (n: number) => `locatie ${n} naam`;

export interface ParsedConfig {
  officeName: string;
  baseDate: string | null;
  /** Ruwe locatienamen 1..5 zoals in CONFIG; leeg/null als niet ingevuld. */
  locationNames: [string | null, string | null, string | null, string | null, string | null];
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
    if (valueIndex === -1) continue;
    values.set(label, row[valueIndex]);
  }

  const officeNameRaw = values.get(LABEL_OFFICE);
  const officeName = officeNameRaw !== undefined ? String(officeNameRaw).trim() : "";
  if (!officeName) {
    throw new ExcelValidationError(`Veld "Kantoor" ontbreekt in sheet CONFIG.`);
  }

  const baseDate = toIsoDateString(values.get(LABEL_BASE_DATE) ?? null);

  const locationNames = [1, 2, 3, 4, 5].map((n) => {
    const raw = values.get(locationLabel(n));
    if (raw === undefined) return null;
    const text = String(raw).trim();
    return text === "" ? null : text;
  }) as ParsedConfig["locationNames"];

  return { officeName, baseDate, locationNames };
}

function isBlankCell(cell: unknown): boolean {
  return cell === null || cell === undefined || String(cell).trim() === "";
}
