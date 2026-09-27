import type { ArticleLocationAssignment, Location } from "../../domain/types";
import { extractDataRows, findHeaderRow } from "./excelHeaderUtils";
import { toBooleanFlag, toStringOrNull } from "./excelValues";

export const ARTIKEL_LOCATIES_SHEET_NAME = "ARTIKEL_LOCATIES";

/**
 * Production-pilot-readiness sprint punt 1 ("Excel portability /
 * ARTIKEL_LOCATIES"): machine-leesbare sheet die de geleerde
 * `ArticleLocationAssignment`'s meeneemt in het gestandaardiseerde
 * Excelbestand. Vóór deze sprint bestond dit begrip UITSLUITEND lokaal in
 * IndexedDB (zie docs/DATA_MODEL.md — "die stond nooit consistent in
 * Excel") — een import op een nieuw toestel/browser had daardoor geen enkele
 * geleerde locatiekoppeling, en moest alles opnieuw "leren" via tellen.
 *
 * "Locatie ID" verwijst naar de stabiele `Location.id` zoals ook bewaard in
 * CONFIG (`Locatie N ID`, zie parseConfig.ts) — NIET naar het weergavenummer
 * (dat verandert bij herordenen). "Locatienaam" is puur informatief/leesbaar
 * voor een mens die het bestand opent; enkel "Locatie ID" wordt bij import
 * gebruikt om te matchen.
 *
 * Bewust ALLE assignments (actief én inactief) — spec: "geleerde
 * ArticleLocationAssignments volledig mee exporteren". Een inactieve
 * (gedeactiveerde) koppeling heeft geen effect op nieuwe stub-tellingen (zie
 * `CountSessionService#buildInitialEntries`, die enkel `active` assignments
 * gebruikt) maar blijft zo toch traceerbaar/herstelbaar na een roundtrip.
 */
export const ARTIKEL_LOCATIES_REQUIRED_HEADERS = [
  "Artikelnr.",
  "Locatie ID",
  "Locatienaam",
  "Actief",
  "Laatst gezien op",
] as const;

/**
 * Leest sheet ARTIKEL_LOCATIES in. Rijen die naar een onbekende (niet meer
 * bestaande) locatie-ID verwijzen worden bewust genegeerd (defensief tegen
 * een handmatig bewerkt of anderszins corrupt bestand) in plaats van de hele
 * import te laten falen — dit is aanvullende, niet-kritische data.
 */
export function parseArtikelLocatiesSheet(
  rows: unknown[][],
  officeId: string,
  locations: Location[],
): ArticleLocationAssignment[] {
  const { headerRowIndex, columnIndexByName } = findHeaderRow(
    rows,
    [...ARTIKEL_LOCATIES_REQUIRED_HEADERS],
    ARTIKEL_LOCATIES_SHEET_NAME,
  );
  const dataRows = extractDataRows(rows, headerRowIndex, columnIndexByName);
  const knownLocationIds = new Set(locations.map((l) => l.id));

  const assignments: ArticleLocationAssignment[] = [];
  for (const row of dataRows) {
    const articleNumber = toStringOrNull(row["Artikelnr."]);
    const locationId = toStringOrNull(row["Locatie ID"]);
    if (!articleNumber || !locationId || !knownLocationIds.has(locationId)) continue;

    const articleId = `${officeId}:${articleNumber}`;
    assignments.push({
      id: `${officeId}:${articleId}:${locationId}`,
      officeId,
      articleId,
      locationId,
      active: toBooleanFlag(row["Actief"], true),
      // Bewust GEEN Date-conversie (zoals toIsoDateString voor CONFIG's
      // basisdatum) — `lastSeenAt` is een volledige ISO-timestamp
      // (`new Date().toISOString()`, zie CountingService), geen kalenderdag.
      // De cel wordt als platte tekst weggeschreven (zie
      // ExcelStockResultExporter.ts) en hier dus ook als platte tekst
      // teruggelezen, zodat de exacte waarde behouden blijft.
      lastSeenAt: toStringOrNull(row["Laatst gezien op"]) ?? new Date(0).toISOString(),
    });
  }
  return assignments;
}
