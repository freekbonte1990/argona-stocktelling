import type { ArticleSnapshotStatus, StockHistoryEntry } from "../../domain/stockSnapshot";
import type { CountSessionType } from "../../domain/types";
import { extractDataRows, findHeaderRow, findOptionalColumnIndex } from "./excelHeaderUtils";
import { toIsoDateString, toNumberOrNull, toStringOrNull } from "./excelValues";

export const HISTORIE_SHEET_NAME = "HISTORIE";

/**
 * Kolomvolgorde exact zoals gespecificeerd: "Teldatum, Tellingtype,
 * Tellingnaam, Artikelnr., Omschrijving, Totale voorraad, Vorige voorraad,
 * Verschil, Kostprijs, Verschil €, Status telling, Locaties".
 */
export const HISTORIE_REQUIRED_HEADERS = [
  "Teldatum",
  "Tellingtype",
  "Tellingnaam",
  "Artikelnr.",
  "Omschrijving",
  "Totale voorraad",
  "Vorige voorraad",
  "Verschil",
  "Kostprijs",
  "Verschil €",
  "Status telling",
  "Locaties",
] as const;

/** Sprint 3.3 §3: optionele kolom (backward-compat, net als "Assortiment actief" in ARTIKEL) — enkel geschreven/gelezen wanneer aanwezig. */
export const HISTORIE_SOURCE_HEADER = "Bron";

/**
 * Vervolg ("makkelijk vergelijken tussen toestellen" — stabiele identiteit):
 * optionele kolom, zelfde backward-compat-idioom als `HISTORIE_SOURCE_HEADER`
 * hierboven — draagt `StockHistoryEntry.sourceSessionId` (het originele,
 * echte `CountSession.id`) zodat een herimport op een ander toestel deze
 * sessie aan haar ECHTE identiteit herkent, niet enkel aan haar naam.
 */
export const HISTORIE_SESSION_ID_HEADER = "Sessie-ID";

const VALID_SESSION_TYPES: CountSessionType[] = ["MONTHLY", "QUARTERLY", "YEARLY", "FULL"];
const VALID_STATUSES: ArticleSnapshotStatus[] = [
  "GETELD",
  "0 BEVESTIGD",
  "OVERGENOMEN",
  "OVERGENOMEN - NIET GETELD",
  "LEGACY",
];

function normalizeSessionType(raw: string | null): CountSessionType {
  const value = (raw ?? "").trim().toUpperCase();
  const match = VALID_SESSION_TYPES.find((t) => t === value);
  return match ?? "FULL";
}

function normalizeStatus(raw: string | null): ArticleSnapshotStatus {
  const value = (raw ?? "").trim().toUpperCase();
  const match = VALID_STATUSES.find((s) => s === value);
  return match ?? "OVERGENOMEN";
}

function parseLocationNames(raw: unknown): string[] {
  const text = toStringOrNull(raw);
  if (!text) return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Leest sheet HISTORIE in — puur SERIALISATIE (geen businesslogica): zet elke
 * rij één-op-één om naar een `StockHistoryEntry`. Ontbreekt de sheet in het
 * bestand (oudere, gestandaardiseerde bestanden zonder rollend archief), dan
 * geeft de aanroeper (ExcelStockSource) gewoon een lege lijst terug — deze
 * functie wordt dan niet aangeroepen.
 */
export function parseHistorieSheet(rows: unknown[][], officeId: string): StockHistoryEntry[] {
  const { headerRowIndex, columnIndexByName } = findHeaderRow(
    rows,
    [...HISTORIE_REQUIRED_HEADERS],
    HISTORIE_SHEET_NAME,
  );
  const dataRows = extractDataRows(rows, headerRowIndex, columnIndexByName);
  const sourceColIndex = findOptionalColumnIndex(rows, headerRowIndex, HISTORIE_SOURCE_HEADER);
  const sessionIdColIndex = findOptionalColumnIndex(rows, headerRowIndex, HISTORIE_SESSION_ID_HEADER);
  const extendedColumnIndexByName = {
    ...columnIndexByName,
    ...(sourceColIndex !== null ? { [HISTORIE_SOURCE_HEADER]: sourceColIndex } : {}),
    ...(sessionIdColIndex !== null ? { [HISTORIE_SESSION_ID_HEADER]: sessionIdColIndex } : {}),
  };
  const extendedDataRows =
    sourceColIndex !== null || sessionIdColIndex !== null
      ? extractDataRows(rows, headerRowIndex, extendedColumnIndexByName)
      : dataRows;

  return extendedDataRows.map((row) => ({
    countDate: toIsoDateString(row["Teldatum"]) ?? "",
    sessionType: normalizeSessionType(toStringOrNull(row["Tellingtype"])),
    sessionName: toStringOrNull(row["Tellingnaam"]) ?? "",
    // De HISTORIE-sheet bewaart enkel het menselijke "Artikelnr.", niet het
    // interne, van officeId afgeleide Article.id — hier reconstrueren we dat
    // exact zoals parseArtikelSheet/buildArticle dat doet, zodat een
    // geïmporteerde HISTORIE-regel correct koppelt aan het bijhorende artikel.
    articleId: `${officeId}:${toStringOrNull(row["Artikelnr."]) ?? ""}`,
    articleNumber: toStringOrNull(row["Artikelnr."]) ?? "",
    description: toStringOrNull(row["Omschrijving"]) ?? "",
    totalCount: toNumberOrNull(row["Totale voorraad"]),
    previousCount: toNumberOrNull(row["Vorige voorraad"]),
    differenceQuantity: toNumberOrNull(row["Verschil"]),
    costPrice: toNumberOrNull(row["Kostprijs"]),
    differenceAmount: toNumberOrNull(row["Verschil €"]),
    status: normalizeStatus(toStringOrNull(row["Status telling"])),
    locationNames: parseLocationNames(row["Locaties"]),
    ...(sourceColIndex !== null
      ? { source: toStringOrNull(row[HISTORIE_SOURCE_HEADER]) === "LEGACY_IMPORT" ? ("LEGACY_IMPORT" as const) : ("APP" as const) }
      : {}),
    ...(sessionIdColIndex !== null
      ? { sourceSessionId: toStringOrNull(row[HISTORIE_SESSION_ID_HEADER]) ?? undefined }
      : {}),
  }));
}
