import * as XLSX from "xlsx";
import type {
  ExportedFile,
  StockResultExportInput,
  StockResultExporter,
} from "../../application/ports/StockResultExporter";
import { buildNextPreviousCounts, type ArticleReviewResult } from "../../domain/review";
import { computeFrequencyBreakdown } from "../../domain/frequency";
import { allLocationsInOrder } from "../../domain/locations";
import type { Article, ArticleLocationAssignment, Location } from "../../domain/types";
import { buildExportFileName } from "../../shared/exportFileName";
import { ARTIKEL_REQUIRED_HEADERS } from "./parseArtikel";
import { buildTellingRequiredHeaders } from "./parseTelling";

/**
 * Exporteert de resultaten van een telling terug naar de gestandaardiseerde
 * Excelstructuur (spec v0.2 §5-6): sheets TELLING, ARTIKEL, CONFIG en
 * NIEUWE_ARTIKELEN.
 *
 * Bewust "dom": alle resultaatberekeningen (nieuwe totale telling, verschil
 * aantal/euro, welke "vorige telling" de volgende cyclus moet gebruiken)
 * gebeuren in `domain/review.ts`. Deze klasse zet enkel dat reeds berekende
 * model om in cellen/rijen/sheets — geen enkele beslissing hier.
 *
 * Headers worden letterlijk overgenomen uit `parseArtikel.ts`/`parseTelling.ts`
 * (dezelfde constantes als bij import), zodat een geëxporteerd bestand
 * gegarandeerd weer door onze eigen naam-gebaseerde headerherkenning
 * ingelezen kan worden (roundtrip, spec v0.2 §8).
 */
export class ExcelStockResultExporter implements StockResultExporter {
  async exportResults(input: StockResultExportInput): Promise<ExportedFile> {
    const { office, session, review, allArticles, assignments } = input;
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

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildTellingSheet(sortedArticles, resultByArticleId, exportLocations)),
      "TELLING",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildArtikelSheet(sortedArticles, nextPreviousCounts)),
      "ARTIKEL",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildConfigSheet(office, exportLocations, allArticles, newBaseDate)),
      "CONFIG",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(
        buildNieuweArtikelenSheet(allArticles, assignments, exportLocations, resultByArticleId),
      ),
      "NIEUWE_ARTIKELEN",
    );

    // XLSX.write met { type: "array" } geeft rechtstreeks een ArrayBuffer
    // terug (geen Uint8Array) — anders dan bij XLSX.read, dus geen extra
    // buffer/byteOffset-behandeling nodig zoals bij het inlezen.
    const data = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    return {
      fileName: buildExportFileName(office.name, newBaseDate),
      data,
    };
  }
}

function completedAtToLocalDate(completedAt: string | null): Date | null {
  if (!completedAt) return null;
  const parsed = new Date(completedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildTellingSheet(
  articles: Article[],
  resultByArticleId: Map<string, ArticleReviewResult>,
  locations: Location[],
): unknown[][] {
  const rows: unknown[][] = [buildTellingRequiredHeaders(locations.length)];
  for (const article of articles) {
    const result = resultByArticleId.get(article.id);
    rows.push(buildTellingRow(article, result, locations));
  }
  return rows;
}

function buildTellingRow(
  article: Article,
  result: ArticleReviewResult | undefined,
  locations: Location[],
): unknown[] {
  if (!result) {
    // Dit artikel maakte geen deel uit van deze sessie (bv. een
    // kwartaalartikel tijdens een maandtelling) — geen verse tellingdata,
    // maar wel zijn stamgegevens en de bestaande "Vorige telling"/waarde.
    const previousValue =
      article.previousCount !== null && article.costPrice !== null
        ? article.previousCount * article.costPrice
        : null;
    return [
      article.articleNumber,
      article.description,
      article.productGroup,
      article.supplier,
      article.rawStatus,
      article.rawCountPeriod,
      article.unit,
      article.previousCount,
      article.costPrice,
      previousValue,
      ...locations.map(() => null),
      null,
      null,
      null,
      null,
      null,
      null, // GETELD? blijft leeg: niet relevant deze cyclus, niet "NEE".
    ];
  }

  const locationsByNumber = new Map(result.perLocation.map((l) => [l.locationNumber, l]));
  const locationValues = locations.map((location) => locationsByNumber.get(location.number)?.quantity ?? null);

  return [
    article.articleNumber,
    article.description,
    article.productGroup,
    article.supplier,
    article.rawStatus,
    article.rawCountPeriod,
    article.unit,
    result.previousCount,
    result.costPrice,
    result.previousValue,
    ...locationValues,
    result.note,
    result.newTotalCount,
    result.amount,
    result.differenceAmount,
    result.differenceQuantity,
    result.fullyCounted ? "JA" : "NEE",
  ];
}

function buildArtikelSheet(
  articles: Article[],
  nextPreviousCounts: Map<string, number | null>,
): unknown[][] {
  const rows: unknown[][] = [[...ARTIKEL_REQUIRED_HEADERS]];
  articles.forEach((article, index) => {
    rows.push([
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
    ]);
  });
  return rows;
}

function buildConfigSheet(
  office: StockResultExportInput["office"],
  locations: Location[],
  allArticles: Article[],
  baseDate: Date,
): unknown[][] {
  const breakdown = computeFrequencyBreakdown(allArticles);
  const temporaryArticleCount = allArticles.filter((a) => a.officialArticleNumber === null).length;

  const rows: unknown[][] = [
    ["STOCKTELLING CONFIG", null],
    [null, null],
    ["Kantoor", office.name],
    ["Basisdatum", baseDate],
  ];
  // Naam, volgorde (= de N-positie zelf) en actieve status per locatie —
  // spec v0.2.1 §1. Ook inactieve locaties blijven vermeld, zodat hun
  // historische kolommen in TELLING altijd herleidbaar blijven.
  for (const location of locations) {
    rows.push([`Locatie ${location.number} naam`, location.name]);
    rows.push([`Locatie ${location.number} actief`, location.active ? "Ja" : "Nee"]);
  }
  rows.push(
    ["Aantal artikels", breakdown.total],
    ["Tijdelijke artikelnummers", temporaryArticleCount],
    ["Ontbrekende telperiode", breakdown.toBeDetermined],
    [null, null],
    [
      "Werkwijze",
      "Dit bestand is gegenereerd door Argona Stocktelling na het afronden van een telling. " +
        "De LOCATIE-kolommen in TELLING tonen de effectief getelde aantallen; AANTAL TOTAAL, " +
        "Bedrag, Verschil Bedrag en VERSCHIL AANTAL zijn automatisch berekend. Vorige telling " +
        "in ARTIKEL is bijgewerkt naar de nieuwe totale telling van deze cyclus.",
    ],
  );
  return rows;
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
  allArticles: Article[],
  assignments: ArticleLocationAssignment[],
  locations: Location[],
  resultByArticleId: Map<string, ArticleReviewResult>,
): unknown[][] {
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
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const newArticles = allArticles
    .filter((article) => article.idType === "TIJDELIJK")
    .sort((a, b) => a.articleNumber.localeCompare(b.articleNumber, "nl", { numeric: true }));

  const rows: unknown[][] = [header];
  for (const article of newArticles) {
    const locationNames = assignments
      .filter((assignment) => assignment.articleId === article.id && assignment.active)
      .map((assignment) => locationById.get(assignment.locationId)?.name)
      .filter((name): name is string => Boolean(name))
      .join(", ");
    const result = resultByArticleId.get(article.id);
    const countedQuantity = result?.fullyCounted ? result.newTotalCount : null;
    rows.push([
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
  }
  return rows;
}
