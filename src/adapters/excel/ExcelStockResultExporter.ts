import ExcelJS from "exceljs";
import type {
  ExportedFile,
  StockResultExportInput,
  StockResultExporter,
} from "../../application/ports/StockResultExporter";
import { buildNextPreviousCounts, type ArticleReviewResult } from "../../domain/review";
import { computeFrequencyBreakdown } from "../../domain/frequency";
import { allLocationsInOrder } from "../../domain/locations";
import { getStockClassification, STOCK_CLASSIFICATION_TO_RAW } from "../../domain/stockClassification";
import type { ArticleSnapshot, StockHistoryEntry, StockSnapshot } from "../../domain/stockSnapshot";
import type { Article, ArticleLocationAssignment, Location, ProductCategory } from "../../domain/types";
import { buildExportFileName } from "../../shared/exportFileName";
import { ARTIKEL_REQUIRED_HEADERS, CATEGORY_ID_HEADER, STOCK_CLASSIFICATION_HEADER } from "./parseArtikel";
import { ARTIKEL_LOCATIES_REQUIRED_HEADERS, ARTIKEL_LOCATIES_SHEET_NAME } from "./parseArtikelLocaties";
import { HISTORIE_REQUIRED_HEADERS } from "./parseHistorie";
import { PRODUCTGAMMAS_REQUIRED_HEADERS, PRODUCTGAMMAS_SHEET_NAME } from "./parseProductGammas";
import { buildTellingRequiredHeaders } from "./parseTelling";
import {
  CURRENCY_DIFF_FORMAT,
  CURRENCY_FORMAT,
  DATE_FORMAT,
  HEADER_FILL_BLUE,
  HEADER_FILL_GREEN,
  HIGHLIGHT_FILL_PEACH,
  HIGHLIGHT_FILL_PURPLE,
  HIGHLIGHT_FILL_YELLOW,
  QUANTITY_DIFF_FORMAT,
  QUANTITY_FORMAT,
  setColumnWidths,
  styleHeaderRow,
  TITLE_FILL_PALE_BLUE,
} from "./excelStyles";

/**
 * Exporteert de resultaten van een telling terug naar de gestandaardiseerde
 * Excelstructuur, uitgebreid met het rollend stockarchief (spec): sheets
 * ARTIKEL, CONFIG, HISTORIE, NIEUWE_ARTIKELEN, plus alle historische,
 * benoemde tellingtabs (bv. "2026-09 Maand") — en `TELLING`, die om
 * backward-compatibiliteitsredenen behouden blijft (zie `buildTellingSheet`
 * hieronder voor de precieze rol die deze sheet nog heeft).
 *
 * Aanvulling ("we moeten exact de layout van de bron terug leveren"): sinds
 * deze versie gebruikt de exporter `exceljs` (i.p.v. het gratis `xlsx`/
 * SheetJS, dat geen celopmaak kan SCHRIJVEN) zodat elke sheet er visueel
 * exact hetzelfde uitziet als het standaard Argona-sjabloon: kleuren,
 * lettertypes, kolombreedtes, bevroren rijen/kolommen en getalnotaties — zie
 * `excelStyles.ts` voor de herkomst van elke waarde. De databerekening zelf
 * (welke waarde in welke cel komt) is ONGEWIJZIGD gebleven t.o.v. de vorige
 * versie; enkel de manier waarop die waarden weggeschreven worden, is nu
 * gestileerd.
 *
 * Bewust "dom": alle resultaatberekeningen (nieuwe totale telling, verschil
 * aantal/euro, welke "vorige telling" de volgende cyclus moet gebruiken, de
 * volledige voorraad-snapshot, de HISTORIE-log) gebeuren in `domain/` en
 * `ExportService`. Deze klasse zet enkel dat reeds berekende model om in
 * cellen/rijen/sheets — geen enkele beslissing hier, en ze wijzigt NOOIT een
 * bestaande historische sheet (die worden hier louter, ongewijzigd,
 * doorgegeven).
 *
 * Headers worden letterlijk overgenomen uit
 * `parseArtikel.ts`/`parseTelling.ts`/`parseHistorie.ts` (dezelfde
 * constantes als bij import), zodat een geëxporteerd bestand gegarandeerd
 * weer door onze eigen naam-gebaseerde headerherkenning ingelezen kan worden
 * (roundtrip, spec v0.2 §8 / rollend archief).
 */
export class ExcelStockResultExporter implements StockResultExporter {
  async exportResults(input: StockResultExportInput): Promise<ExportedFile> {
    const { office, session, review, allArticles, assignments, categories, snapshot, historicalSheets, historyEntries } =
      input;
    const resultByArticleId = new Map(review.results.map((r) => [r.articleId, r]));
    const nextPreviousCounts = buildNextPreviousCounts(allArticles, review.results);

    // ALLE locaties (actief + inactief), in volgorde — een inactief gemaakte
    // locatie mag haar historische tellingen in de export nooit verliezen
    // (spec v0.2.1 §1: "historische tellingen mogen nooit breken door
    // locatiebeheer").
    const exportLocations = allLocationsInOrder(office);

    // Stabiele volgorde voor leesbaarheid: zoals in het bronbestand (Bronrij).
    const sortedArticles = [...allArticles].sort(
      (a, b) => (a.sourceRow ?? 0) - (b.sourceRow ?? 0),
    );

    const newBaseDate = completedAtToLocalDate(session.completedAt) ?? new Date();

    const workbook = new ExcelJS.Workbook();

    buildTellingSheet(workbook, office, session, sortedArticles, resultByArticleId, exportLocations, newBaseDate);
    buildArtikelSheet(workbook, sortedArticles, nextPreviousCounts);
    buildConfigSheet(workbook, office, exportLocations, allArticles, newBaseDate);
    buildNieuweArtikelenSheet(workbook, allArticles, assignments, exportLocations, resultByArticleId);
    buildArtikelLocatiesSheet(workbook, allArticles, assignments, exportLocations);
    buildHistorieSheet(workbook, historyEntries);
    buildProductGammasSheet(workbook, categories);

    // Alle reeds gekende, ANDERE historische tellingtabs: ongewijzigd
    // doorgeven. `historicalSheets` bevat per constructie nooit een tab met
    // dezelfde naam als `snapshot.sessionName` (die check gebeurt vooraf in
    // ExportService) en nooit een van de vaste tabnamen hierboven.
    for (const historicalSheet of historicalSheets) {
      buildPassthroughSheet(workbook, historicalSheet.sheetName, historicalSheet.rows);
    }

    // Het NIEUWE, benoemde tellingtabblad van deze sessie (spec: "elke
    // nieuwe stocktelling voegt één nieuw, bevroren telling-tabblad toe").
    // Was dit tabblad al eerder gegenereerd (herhaalde export van dezelfde,
    // al afgeronde sessie), dan hergebruiken we die exact bevroren rijen in
    // plaats van ze te herberekenen — zie `StockResultExportInput.frozenSnapshotRows`.
    const namedSheetRows = input.frozenSnapshotRows ?? buildNamedSnapshotSheetRows(snapshot, exportLocations);
    buildNamedSnapshotSheet(workbook, snapshot.sessionName, namedSheetRows);

    const data = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;

    return {
      fileName: buildExportFileName(office.name, newBaseDate),
      data,
      // Enkel meegeven wanneer dit tabblad VERS gegenereerd werd — bij
      // hergebruik (frozenSnapshotRows) hoeft ExportService niets nieuws te
      // bewaren, het was al bevroren.
      newHistoricalSheet: input.frozenSnapshotRows
        ? undefined
        : { sheetName: snapshot.sessionName, rows: namedSheetRows },
    };
  }
}

function completedAtToLocalDate(completedAt: string | null): Date | null {
  if (!completedAt) return null;
  const parsed = new Date(completedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * TELLING — ROL SINDS HET ROLLEND STOCKARCHIEF: deze sheet blijft uitsluitend
 * bestaan voor backward compatibility met de bestaande import/export-
 * architectuur (o.a. `parseTelling.ts#validateTellingSheet`, aangeroepen door
 * elke import). Ze toont enkel de resultaten van de FYSIEKE sessiescope van
 * deze cyclus (net als voorheen) en is dus GEEN volledige voorraad-snapshot.
 * Het menselijke archief zit voortaan in de benoemde tellingtabs (bv.
 * "2026-09 Maand") — zie `buildNamedSnapshotSheetRows` — en het
 * machineleesbare archief in `HISTORIE` — zie `buildHistorieSheet`.
 *
 * Opmaak (aanvulling "exacte layout"): identiek aan het standaard sjabloon —
 * kolom A blijft een lege spacer (breedte 2), de metadata (Kantoor/
 * Bronbestand/Basisdatum/Opmerking) en de titelrij staan boven de tabel,
 * de headerrij is groen (thema-accent3) i.p.v. blauw (zo ziet TELLING er
 * altijd net iets anders uit dan ARTIKEL/NIEUWE_ARTIKELEN — exact zoals in
 * het bronbestand), en de LOCATIE-kolommen krijgen een lichtpaarse band.
 */
function buildTellingSheet(
  workbook: ExcelJS.Workbook,
  office: StockResultExportInput["office"],
  session: StockResultExportInput["session"],
  articles: Article[],
  resultByArticleId: Map<string, ArticleReviewResult>,
  locations: Location[],
  newBaseDate: Date,
): void {
  const sheet = workbook.addWorksheet("TELLING");
  const headers = buildTellingRequiredHeaders(locations.length);
  const columnCount = headers.length + 1; // + spacerkolom A

  setColumnWidths(sheet, [2, 17, 58, 22, 22, 20, 15, 12, 14, 13, 18, ...locations.map(() => 14), 44, 17, 15, 17, 17, 12]);

  sheet.getCell("B2").value = "Kantoor";
  sheet.getCell("B2").font = { bold: true };
  sheet.getCell("C2").value = office.name;
  sheet.getCell("B3").value = "Bronbestand";
  sheet.getCell("B3").font = { bold: true };
  sheet.getCell("C3").value = session.sourceFileName;
  sheet.getCell("B4").value = "Basisdatum";
  sheet.getCell("B4").font = { bold: true };
  const baseDateCell = sheet.getCell("C4");
  baseDateCell.value = newBaseDate;
  baseDateCell.numFmt = DATE_FORMAT;
  sheet.getCell("B5").value = "Opmerking";
  sheet.getCell("B5").font = { bold: true };
  sheet.getCell("C5").value =
    "Nieuwe telling gebeurt in LOCATIE 1 t/m " +
    `${locations.length}; AANTAL TOTAAL en verschillen worden automatisch berekend.`;

  const titleRow = 13;
  const headerRow = 14;
  const titleCell = sheet.getCell(titleRow, 2);
  titleCell.value = `TELLING - ${office.name.toUpperCase()}`;
  titleCell.font = { bold: true, italic: true };
  titleCell.alignment = { horizontal: "center" };
  titleCell.fill = TITLE_FILL_PALE_BLUE;
  sheet.mergeCells(titleRow, 2, titleRow, columnCount - 1);

  const header = sheet.getRow(headerRow);
  headers.forEach((label, index) => {
    header.getCell(index + 2).value = label;
  });
  styleHeaderRow(header, HEADER_FILL_GREEN, columnCount);
  header.height = 30;

  // 1-based kolomindex van "LOCATIE 1": header-rij is al uniform groen
  // gestijld door `styleHeaderRow` hierboven, dus hier enkel de positie nodig.
  const locationColStart = 2 + TELLING_HEADERS_BEFORE_LOCATIONS_LENGTH;

  // Bevries kolom A t/m C en rij 1 t/m 14 (spiegelt het bronbestand: freeze op D15).
  sheet.views = [{ state: "frozen", xSplit: 3, ySplit: headerRow }];

  articles.forEach((article, index) => {
    const result = resultByArticleId.get(article.id);
    const row = sheet.getRow(headerRow + 1 + index);
    writeTellingRow(row, article, result, locations, locationColStart);
  });
}

// Artikelnr., Omschrijving, Productgroep, Leverancier, Artikelstatus,
// TELPERIODE, Eenheid, Vorige telling, Kostprijs, Waarde vorige telling —
// 10 kolommen ná de spacerkolom A, vóór "LOCATIE 1" begint.
const TELLING_HEADERS_BEFORE_LOCATIONS_LENGTH = 10;

function writeTellingRow(
  row: ExcelJS.Row,
  article: Article,
  result: ArticleReviewResult | undefined,
  locations: Location[],
  locationColStart: number,
): void {
  const isMissingOfficialNumber = article.officialArticleNumber === null;
  const isUnknownPeriod = article.rawCountPeriod === "NOG TE BEPALEN";

  const col = (offset: number) => 2 + offset; // 0-based headeroffset -> 1-based kolomindex (na spacer A)

  row.getCell(col(0)).value = article.articleNumber;
  row.getCell(col(1)).value = article.description;
  row.getCell(col(2)).value = article.productGroup;
  row.getCell(col(3)).value = article.supplier;
  row.getCell(col(4)).value = article.rawStatus;
  row.getCell(col(5)).value = article.rawCountPeriod;
  row.getCell(col(6)).value = article.unit;

  const previousCount = result ? result.previousCount : article.previousCount;
  const costPrice = result ? result.costPrice : article.costPrice;
  const previousValue =
    result?.previousValue ?? (previousCount !== null && costPrice !== null ? previousCount * costPrice : null);
  row.getCell(col(7)).value = previousCount;
  row.getCell(col(7)).numFmt = QUANTITY_FORMAT;
  row.getCell(col(8)).value = costPrice;
  row.getCell(col(8)).numFmt = CURRENCY_FORMAT;
  row.getCell(col(9)).value = previousValue;
  row.getCell(col(9)).numFmt = CURRENCY_FORMAT;

  const locationsByNumber = new Map((result?.perLocation ?? []).map((l) => [l.locationNumber, l]));
  locations.forEach((location, i) => {
    const cell = row.getCell(locationColStart + i);
    cell.value = locationsByNumber.get(location.number)?.quantity ?? null;
    cell.fill = HIGHLIGHT_FILL_PURPLE;
  });

  const afterLocationsCol = locationColStart + locations.length;
  // Zelfde inhoud als voorheen (`result?.note ?? null`, geen fictieve tekst
  // verzonnen) — enkel de peach-highlight hieronder is nieuw, puur visueel.
  row.getCell(afterLocationsCol).value = result?.note ?? null;
  row.getCell(afterLocationsCol + 1).value = result ? result.newTotalCount : null;
  row.getCell(afterLocationsCol + 1).numFmt = QUANTITY_DIFF_FORMAT;
  row.getCell(afterLocationsCol + 2).value = result ? result.amount : null;
  row.getCell(afterLocationsCol + 2).numFmt = CURRENCY_FORMAT;
  row.getCell(afterLocationsCol + 3).value = result ? result.differenceAmount : null;
  row.getCell(afterLocationsCol + 3).numFmt = CURRENCY_DIFF_FORMAT;
  row.getCell(afterLocationsCol + 4).value = result ? result.differenceQuantity : null;
  row.getCell(afterLocationsCol + 4).numFmt = QUANTITY_DIFF_FORMAT;
  const geteldCell = row.getCell(afterLocationsCol + 5);
  geteldCell.value = result ? (result.fullyCounted ? "JA" : "NEE") : null;
  geteldCell.alignment = { horizontal: "center" };

  if (isMissingOfficialNumber) {
    row.getCell(col(0)).fill = HIGHLIGHT_FILL_PEACH;
    row.getCell(afterLocationsCol).fill = HIGHLIGHT_FILL_PEACH;
  }
  if (isUnknownPeriod) {
    row.getCell(col(5)).fill = HIGHLIGHT_FILL_YELLOW;
  }
}

function buildArtikelSheet(
  workbook: ExcelJS.Workbook,
  articles: Article[],
  nextPreviousCounts: Map<string, number | null>,
): void {
  const sheet = workbook.addWorksheet("ARTIKEL");
  const headers = [...ARTIKEL_REQUIRED_HEADERS, STOCK_CLASSIFICATION_HEADER, CATEGORY_ID_HEADER];
  setColumnWidths(sheet, [18, 20, 12, 60, 24, 24, 12, 14, 16, 20, 15, 10, 20, 24]);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const header = sheet.addRow(headers);
  styleHeaderRow(header, HEADER_FILL_BLUE, headers.length);

  articles.forEach((article, index) => {
    const row = sheet.addRow([
      article.articleNumber,
      article.officialArticleNumber,
      article.idType,
      article.description,
      article.productGroup,
      article.supplier,
      article.unit,
      article.costPrice,
      article.rawCountPeriod,
      article.rawStatus,
      // Kern van spec §5: de nieuwe totale telling dient als volgende "Vorige
      // telling" — behalve voor artikelen die deze cyclus niet meetelden.
      nextPreviousCounts.get(article.id) ?? article.previousCount,
      index + 2, // Bronrij: nieuwe, interne rijpositie in dit geëxporteerde bestand.
      // Sprint 2 §5/§14: "Voorraadclassificatie" — additief, altijd
      // geëxporteerd als expliciete ACTIEF/OBSOLETE-tekst (nooit leeg), zodat
      // een herimport op een leeg toestel exact dezelfde classificatie
      // terugkrijgt.
      STOCK_CLASSIFICATION_TO_RAW[getStockClassification(article)],
      // Sprint 3.2 §14: "Productgamma ID" — de stabiele, globale
      // `ProductCategory.id` (of `null` voor "niet ingedeeld"). Een artikel
      // dat nog nooit geclassificeerd werd (`categoryId === undefined`)
      // exporteert hier ook gewoon `null` — het onderscheid
      // undefined/null bestaat uitsluitend om bij IMPORT een oud bestand
      // zonder deze kolom te herkennen (zie parseArtikel.ts), niet om apart
      // te exporteren.
      article.categoryId ?? null,
    ]);
    row.getCell(8).numFmt = CURRENCY_FORMAT; // Kostprijs
    row.getCell(11).numFmt = QUANTITY_FORMAT; // Vorige telling
    if (article.officialArticleNumber === null) {
      row.getCell(1).fill = HIGHLIGHT_FILL_PEACH; // Artikelnr.
    }
    if (article.rawCountPeriod === "NOG TE BEPALEN") {
      row.getCell(9).fill = HIGHLIGHT_FILL_YELLOW; // TELPERIODE
    }
  });
}

function buildConfigSheet(
  workbook: ExcelJS.Workbook,
  office: StockResultExportInput["office"],
  locations: Location[],
  allArticles: Article[],
  baseDate: Date,
): void {
  const sheet = workbook.addWorksheet("CONFIG");
  setColumnWidths(sheet, [28, 44]);

  const breakdown = computeFrequencyBreakdown(allArticles);
  const temporaryArticleCount = allArticles.filter((a) => a.officialArticleNumber === null).length;

  const addLabelRow = (label: string, value: unknown, numFmt?: string): void => {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (numFmt) row.getCell(2).numFmt = numFmt;
  };

  const titleRow = sheet.addRow(["STOCKTELLING CONFIG", null]);
  titleRow.getCell(1).font = { bold: true, size: 14 };
  sheet.addRow([null, null]);
  addLabelRow("Kantoor", office.name);
  addLabelRow("Basisdatum", baseDate, DATE_FORMAT);
  for (const location of locations) {
    addLabelRow(`Locatie ${location.number} naam`, location.name);
    addLabelRow(`Locatie ${location.number} actief`, location.active ? "Ja" : "Nee");
    // Production-pilot-readiness sprint punt 1 ("stabiele location identity"):
    // de technische, interne `Location.id` — nooit tonen als iets om zelf aan
    // te passen, enkel om bij een volgende import dezelfde locatie exact
    // terug te herkennen, ook na hernoemen/herordenen. Zie parseConfig.ts.
    addLabelRow(`Locatie ${location.number} ID`, location.id);
  }
  addLabelRow("Aantal artikels", breakdown.total);
  addLabelRow("Tijdelijke artikelnummers", temporaryArticleCount);
  addLabelRow("Ontbrekende telperiode", breakdown.toBeDetermined);
  sheet.addRow([null, null]);
  const werkwijzeRow = sheet.addRow([
    "Werkwijze",
    "Dit bestand is gegenereerd door Argona Stocktelling na het afronden van een telling. " +
      "De LOCATIE-kolommen in TELLING tonen de effectief getelde aantallen; AANTAL TOTAAL, " +
      "Bedrag, Verschil Bedrag en VERSCHIL AANTAL zijn automatisch berekend. Vorige telling " +
      "in ARTIKEL is bijgewerkt naar de nieuwe totale telling van deze cyclus.",
  ]);
  werkwijzeRow.getCell(1).font = { bold: true };
  werkwijzeRow.getCell(2).alignment = { wrapText: true, vertical: "top" };
  // Bronsjabloon gebruikt hoogte 45 voor een veel kortere tekst — onze
  // volledige toelichting (hierboven) is langer en heeft daarom meer
  // regels nodig om niet afgesneden te worden bij het wrappen.
  werkwijzeRow.height = 110;
}

/**
 * NIEUWE_ARTIKELEN (v0.2.1 correctieronde §3C): alle artikelen die via "+
 * Nieuw artikel" of "+ Nieuw artikel gevonden" ontstaan zijn (`idType ===
 * "TIJDELIJK"`), met hun huidige stocklocatie(s) en — indien deze sessie
 * effectief geteld — de getelde hoeveelheid. Bewust enkel INFORMATIEF: deze
 * sheet wordt nooit opnieuw ingelezen bij import (zie parseArtikel.ts) — het
 * tijdelijke artikel zelf staat ook gewoon in ARTIKEL (die sheet bevat ALLE
 * artikelen), en komt zo, samen met zijn ArticleLocationAssignment (die
 * import nooit aanraakt), altijd zonder verlies of duplicatie terug via een
 * herimport (spec: "mag het nieuwe tijdelijke artikel niet verliezen of
 * dupliceren").
 */
function buildNieuweArtikelenSheet(
  workbook: ExcelJS.Workbook,
  allArticles: Article[],
  assignments: ArticleLocationAssignment[],
  locations: Location[],
  resultByArticleId: Map<string, ArticleReviewResult>,
): void {
  const header = [
    "Tijdelijk ID",
    "Omschrijving",
    "Productgroep",
    "Leverancier",
    "Eenheid",
    "TELPERIODE",
    "Locatie",
    "Aantal",
    "Kostprijs",
    "Opmerking",
    "Officieel artikelnr. na aanmaak",
  ];
  const sheet = workbook.addWorksheet("NIEUWE_ARTIKELEN");
  setColumnWidths(sheet, [18, 60, 24, 24, 12, 16, 16, 12, 14, 45, 24]);
  const headerRow = sheet.addRow(header);
  styleHeaderRow(headerRow, HEADER_FILL_BLUE, header.length);

  const locationById = new Map(locations.map((l) => [l.id, l]));
  const newArticles = allArticles
    .filter((article) => article.idType === "TIJDELIJK")
    .sort((a, b) => a.articleNumber.localeCompare(b.articleNumber, "nl", { numeric: true }));

  for (const article of newArticles) {
    const locationNames = assignments
      .filter((assignment) => assignment.articleId === article.id && assignment.active)
      .map((assignment) => locationById.get(assignment.locationId)?.name)
      .filter((name): name is string => Boolean(name))
      .join(", ");
    const result = resultByArticleId.get(article.id);
    const countedQuantity = result?.fullyCounted ? result.newTotalCount : null;
    const row = sheet.addRow([
      article.articleNumber,
      article.description,
      article.productGroup,
      article.supplier,
      article.unit,
      article.rawCountPeriod,
      locationNames || null,
      countedQuantity,
      article.costPrice,
      article.comment ?? null,
      article.officialArticleNumber,
    ]);
    row.getCell(8).numFmt = QUANTITY_FORMAT; // Aantal
    row.getCell(9).numFmt = CURRENCY_FORMAT; // Kostprijs
    // Sjabloon: de volledige (invulbare) rij is lichtgeel, behalve de laatste
    // kolom ("Officieel artikelnr. na aanmaak") — zie excelStyles.ts.
    for (let col = 1; col <= header.length - 1; col++) {
      row.getCell(col).fill = HIGHLIGHT_FILL_YELLOW;
    }
  }
}

/**
 * ARTIKEL_LOCATIES (production-pilot-readiness sprint punt 1, "Excel
 * portability"): machine-leesbare export van ALLE geleerde
 * `ArticleLocationAssignment`'s (actief én inactief — spec: "volledig mee
 * exporteren", zie parseArtikelLocaties.ts voor de volledige uitleg). Dit was
 * vóór deze sprint zuiver lokale IndexedDB-kennis; een import op een nieuw
 * toestel/browser kende daardoor nooit welke artikelen waar verwacht worden,
 * en moest alles herleren via tellen. "Locatie ID" is de stabiele,
 * technische `Location.id` (zie ook de nieuwe "Locatie N ID"-rijen in
 * CONFIG hierboven) — "Locatienaam" is puur ter info voor een mens die het
 * bestand opent, en wordt bij import genegeerd.
 */
function buildArtikelLocatiesSheet(
  workbook: ExcelJS.Workbook,
  allArticles: Article[],
  assignments: ArticleLocationAssignment[],
  locations: Location[],
): void {
  const sheet = workbook.addWorksheet(ARTIKEL_LOCATIES_SHEET_NAME);
  const header = [...ARTIKEL_LOCATIES_REQUIRED_HEADERS];
  setColumnWidths(sheet, [18, 20, 30, 10, 20]);
  const headerRow = sheet.addRow(header);
  styleHeaderRow(headerRow, HEADER_FILL_BLUE, header.length);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const articleById = new Map(allArticles.map((a) => [a.id, a]));
  const locationById = new Map(locations.map((l) => [l.id, l]));

  // Stabiele, deterministische volgorde (nooit afhankelijk van
  // insertievolgorde in IndexedDB) — leesbaar per artikel, dan per locatie.
  const sorted = [...assignments].sort((a, b) => {
    const articleCompare = (articleById.get(a.articleId)?.articleNumber ?? a.articleId).localeCompare(
      articleById.get(b.articleId)?.articleNumber ?? b.articleId,
      "nl",
      { numeric: true },
    );
    if (articleCompare !== 0) return articleCompare;
    return (locationById.get(a.locationId)?.number ?? 0) - (locationById.get(b.locationId)?.number ?? 0);
  });

  for (const assignment of sorted) {
    const article = articleById.get(assignment.articleId);
    // Een assignment zonder (meer) gekend artikel kan in theorie niet
    // voorkomen (artikelen worden nooit verwijderd), maar defensief overslaan
    // i.p.v. een lege/foutieve rij te schrijven.
    if (!article) continue;
    const location = locationById.get(assignment.locationId);
    sheet.addRow([
      article.articleNumber,
      assignment.locationId,
      location?.name ?? null,
      assignment.active ? "Ja" : "Nee",
      assignment.lastSeenAt,
    ]);
  }
}

/**
 * PRODUCTGAMMAS (Sprint 3.2 §14, "Excel portability"): machine-leesbare
 * export van de VOLLEDIGE, bedrijfsbrede/globale Productgamma-lijst (zie
 * `ProductCategory`/parseProductGammas.ts) — exact hetzelfde precedent als
 * ARTIKEL_LOCATIES hierboven. "Productgamma ID" is de stabiele, globale
 * `ProductCategory.id`; de koppeling artikel -> categorie zelf staat in
 * ARTIKEL's "Productgamma ID"-kolom (zie `buildArtikelSheet`), niet hier.
 *
 * Volgorde: naar `sortOrder` (de door de gebruiker gekozen weergavevolgorde
 * in Instellingen), niet naar insertievolgorde — zodat een export altijd
 * dezelfde, deterministische volgorde toont als de UI.
 */
function buildProductGammasSheet(workbook: ExcelJS.Workbook, categories: ProductCategory[]): void {
  const sheet = workbook.addWorksheet(PRODUCTGAMMAS_SHEET_NAME);
  const header = [...PRODUCTGAMMAS_REQUIRED_HEADERS];
  setColumnWidths(sheet, [24, 30, 12, 10]);
  const headerRow = sheet.addRow(header);
  styleHeaderRow(headerRow, HEADER_FILL_BLUE, header.length);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const category of sorted) {
    sheet.addRow([category.id, category.name, category.sortOrder, category.active ? "Ja" : "Nee"]);
  }
}

/**
 * Bouwt het NIEUWE, benoemde tellingtabblad van deze sessie (bv.
 * "2026-09 Maand") uit een reeds volledig berekende `StockSnapshot` (zie
 * `domain/stockSnapshot.ts#buildSessionSnapshot`) — een volledige
 * voorraad-snapshot van ALLE artikelen van het kantoor, niet enkel de
 * sessiescope (spec: "een tellingtabblad moet een volledige
 * voorraad-snapshot zijn"). Kolomvolgorde en dynamische LOCATIE-kolommen
 * spiegelen bewust `buildTellingSheet`/`writeTellingRow`, met als enige
 * betekenisvol verschil de laatste kolom: "Status telling"
 * (GETELD/OVERGENOMEN/OVERGENOMEN - NIET GETELD/0 BEVESTIGD) i.p.v. het oude
 * "GETELD?" (JA/NEE/null).
 */
function buildNamedSnapshotSheetRows(snapshot: StockSnapshot, locations: Location[]): unknown[][] {
  const header = [
    "Artikelnr.",
    "Omschrijving",
    "Productgroep",
    "Leverancier",
    "Artikelstatus",
    "Telperiode",
    "Eenheid",
    "Vorige telling",
    "Kostprijs",
    ...locations.map((l) => `LOCATIE ${l.number}`),
    "Nieuwe telling",
    "Verschil aantal",
    "Verschil bedrag",
    "Opmerking",
    "Status telling",
  ];

  const rows: unknown[][] = [header];
  for (const articleSnapshot of snapshot.articles) {
    rows.push(buildNamedSnapshotRow(articleSnapshot, locations));
  }
  return rows;
}

function buildNamedSnapshotRow(articleSnapshot: ArticleSnapshot, locations: Location[]): unknown[] {
  const { article } = articleSnapshot;
  const locationsByNumber = new Map(articleSnapshot.perLocation.map((l) => [l.locationNumber, l]));
  const locationValues = locations.map((location) => locationsByNumber.get(location.number)?.quantity ?? null);

  return [
    article.articleNumber,
    article.description,
    article.productGroup,
    article.supplier,
    article.rawStatus,
    article.rawCountPeriod,
    article.unit,
    articleSnapshot.previousCount,
    articleSnapshot.costPrice,
    ...locationValues,
    articleSnapshot.totalCount,
    articleSnapshot.differenceQuantity,
    articleSnapshot.differenceAmount,
    articleSnapshot.note,
    articleSnapshot.status,
  ];
}

const NAMED_SNAPSHOT_LOCATION_COL_OFFSET = 9; // Artikelnr. t/m Kostprijs = 9 kolommen vóór LOCATIE 1

/**
 * Schrijft het benoemde tellingtabblad (nieuw berekend of hergebruikt via
 * `frozenSnapshotRows`/`historicalSheets`) — zie `buildPassthroughSheet` voor
 * waarom dit dezelfde ARTIKEL-achtige (blauwe) headerstijl krijgt: er is geen
 * "brontabblad" waarvan de opmaak letterlijk kan overgenomen worden (dit
 * tabblad bestaat pas sinds het rollend archief), dus we gebruiken bewust
 * dezelfde huisstijl als de rest van het werkblad voor een consistent geheel.
 */
/** Redelijke kolombreedte per bekende kolomnaam — hergebruikt over de nieuwe
 * (niet in het bronsjabloon aanwezige) sheets, zodat getallen nooit als
 * "###" verschijnen en tekstkolommen leesbaar breed staan. */
const KNOWN_COLUMN_WIDTHS: Record<string, number> = {
  "Artikelnr.": 17,
  Omschrijving: 58,
  Productgroep: 22,
  Leverancier: 22,
  Artikelstatus: 20,
  Telperiode: 15,
  TELPERIODE: 15,
  Eenheid: 12,
  "Vorige telling": 14,
  Kostprijs: 13,
  "Nieuwe telling": 14,
  "Verschil aantal": 17,
  "Verschil bedrag": 17,
  Opmerking: 44,
  "Status telling": 26,
  Teldatum: 12,
  Tellingtype: 14,
  Tellingnaam: 16,
  "Totale voorraad": 14,
  "Vorige voorraad": 14,
  Verschil: 12,
  "Verschil €": 13,
  Locaties: 30,
};

function widthsForHeader(headerNames: unknown[]): number[] {
  return headerNames.map((name) => {
    if (typeof name === "string") {
      if (KNOWN_COLUMN_WIDTHS[name] !== undefined) return KNOWN_COLUMN_WIDTHS[name];
      if (name.startsWith("LOCATIE ")) return 14;
    }
    return 14;
  });
}

function buildNamedSnapshotSheet(workbook: ExcelJS.Workbook, sheetName: string, rows: unknown[][]): void {
  const sheet = workbook.addWorksheet(sheetName);
  if (rows.length === 0) return;
  const [header, ...dataRows] = rows;
  const columnCount = (header as unknown[]).length;
  setColumnWidths(sheet, widthsForHeader(header as unknown[]));

  const headerRow = sheet.addRow(header as unknown[]);
  styleHeaderRow(headerRow, HEADER_FILL_BLUE, columnCount);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const headerNames = header as string[];
  const costPriceCol = headerNames.indexOf("Kostprijs") + 1;
  const previousCol = headerNames.indexOf("Vorige telling") + 1;
  const newTotalCol = headerNames.indexOf("Nieuwe telling") + 1;
  const diffAmountCol = headerNames.indexOf("Verschil bedrag") + 1;
  const diffQtyCol = headerNames.indexOf("Verschil aantal") + 1;
  const locationColCount = headerNames.filter(
    (h): h is string => typeof h === "string" && h.startsWith("LOCATIE "),
  ).length;

  for (const rowValues of dataRows) {
    const row = sheet.addRow(rowValues);
    if (costPriceCol > 0) row.getCell(costPriceCol).numFmt = CURRENCY_FORMAT;
    if (previousCol > 0) row.getCell(previousCol).numFmt = QUANTITY_FORMAT;
    if (newTotalCol > 0) row.getCell(newTotalCol).numFmt = QUANTITY_DIFF_FORMAT;
    if (diffAmountCol > 0) row.getCell(diffAmountCol).numFmt = CURRENCY_DIFF_FORMAT;
    if (diffQtyCol > 0) row.getCell(diffQtyCol).numFmt = QUANTITY_DIFF_FORMAT;
    for (let i = 0; i < locationColCount; i++) {
      row.getCell(NAMED_SNAPSHOT_LOCATION_COL_OFFSET + 1 + i).fill = HIGHLIGHT_FILL_PURPLE;
    }
  }
}

/**
 * HISTORIE — de machinevriendelijke, ever-groeiende telhistoriek: één regel
 * per artikel per snapshot (spec). Wordt bij elke export volledig VERS
 * herschreven uit de reeds samengevoegde/gededupliceerde lijst die
 * `ExportService` aanlevert (bestaande + nieuwe regels voor deze sessie) —
 * in tegenstelling tot de benoemde tellingtabs is dit dus geen bevroren
 * passthrough, maar telkens een volledige herschrijving van dezelfde,
 * groeiende log.
 */
function buildHistorieSheet(workbook: ExcelJS.Workbook, entries: StockHistoryEntry[]): void {
  const sheet = workbook.addWorksheet("HISTORIE");
  const header = [...HISTORIE_REQUIRED_HEADERS];
  setColumnWidths(sheet, widthsForHeader(header));
  const headerRow = sheet.addRow(header);
  styleHeaderRow(headerRow, HEADER_FILL_BLUE, header.length);
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const entry of entries) {
    const row = sheet.addRow([
      entry.countDate,
      entry.sessionType,
      entry.sessionName,
      entry.articleNumber,
      entry.description,
      entry.totalCount,
      entry.previousCount,
      entry.differenceQuantity,
      entry.costPrice,
      entry.differenceAmount,
      entry.status,
      entry.locationNames.length > 0 ? entry.locationNames.join(", ") : null,
    ]);
    row.getCell(6).numFmt = QUANTITY_FORMAT; // Totale voorraad
    row.getCell(7).numFmt = QUANTITY_FORMAT; // Vorige voorraad
    row.getCell(8).numFmt = QUANTITY_DIFF_FORMAT; // Verschil
    row.getCell(9).numFmt = CURRENCY_FORMAT; // Kostprijs
    row.getCell(10).numFmt = CURRENCY_DIFF_FORMAT; // Verschil €
  }
}

/**
 * Reeds bestaande historische tellingtabs (geïmporteerd en/of eerder door
 * een vorige sessie bevroren): ONGEWIJZIGD als ruwe waarden teruggeschreven
 * (spec: "een bestaand historisch tellingtabblad mag nooit gewijzigd of
 * overschreven worden"). We passen wel dezelfde consistente headerstijl toe
 * op de eerste rij (indien aanwezig) — dat wijzigt geen enkele WAARDE, enkel
 * hoe de sheet er visueel bij staat, en houdt het volledige werkblad
 * visueel één geheel.
 */
function buildPassthroughSheet(workbook: ExcelJS.Workbook, sheetName: string, rows: unknown[][]): void {
  const sheet = workbook.addWorksheet(sheetName);
  if (rows.length > 0 && rows[0].length > 0) {
    setColumnWidths(sheet, widthsForHeader(rows[0]));
  }
  rows.forEach((rowValues, index) => {
    const row = sheet.addRow(rowValues);
    if (index === 0 && rowValues.length > 0) {
      styleHeaderRow(row, HEADER_FILL_BLUE, rowValues.length);
    }
  });
  if (rows.length > 0) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }
}
