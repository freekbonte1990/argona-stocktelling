import * as XLSX from "xlsx";
import type {
  ExportedFile,
  StockResultExportInput,
  StockResultExporter,
} from "../../application/ports/StockResultExporter";
import { buildNextPreviousCounts, type ArticleReviewResult } from "../../domain/review";
import { computeFrequencyBreakdown } from "../../domain/frequency";
import type { Article } from "../../domain/types";
import { buildExportFileName } from "../../shared/exportFileName";
import { ARTIKEL_REQUIRED_HEADERS } from "./parseArtikel";
import { TELLING_REQUIRED_HEADERS } from "./parseTelling";

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
    const { office, session, review, allArticles } = input;
    const resultByArticleId = new Map(review.results.map((r) => [r.articleId, r]));
    const nextPreviousCounts = buildNextPreviousCounts(allArticles, review.results);

    // Stabiele volgorde voor leesbaarheid: zoals in het bronbestand (Bronrij).
    const sortedArticles = [...allArticles].sort(
      (a, b) => (a.sourceRow ?? 0) - (b.sourceRow ?? 0),
    );

    const newBaseDate = completedAtToLocalDate(session.completedAt) ?? new Date();

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildTellingSheet(sortedArticles, resultByArticleId)),
      "TELLING",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildArtikelSheet(sortedArticles, nextPreviousCounts)),
      "ARTIKEL",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildConfigSheet(office, allArticles, newBaseDate)),
      "CONFIG",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(buildNieuweArtikelenSheet(office.name)),
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
): unknown[][] {
  const rows: unknown[][] = [[...TELLING_REQUIRED_HEADERS]];
  for (const article of articles) {
    const result = resultByArticleId.get(article.id);
    rows.push(buildTellingRow(article, result));
  }
  return rows;
}

function buildTellingRow(article: Article, result: ArticleReviewResult | undefined): unknown[] {
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
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null, // GETELD? blijft leeg: niet relevant deze cyclus, niet "NEE".
    ];
  }

  const locationsByNumber = new Map(result.perLocation.map((l) => [l.locationNumber, l]));
  const locationValues = [1, 2, 3, 4, 5].map((n) => locationsByNumber.get(n as 1 | 2 | 3 | 4 | 5)?.quantity ?? null);

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
  for (const location of office.locations) {
    rows.push([`Locatie ${location.number} naam`, location.name]);
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

function buildNieuweArtikelenSheet(officeName: string): unknown[][] {
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
  const code = officeName.trim().slice(0, 3).toUpperCase() || "OFF";
  const rows: unknown[][] = [header];
  // Enkel de kolomstructuur behouden (spec §5: "behoud ook ... NIEUWE_ARTIKELEN") —
  // deze sprint bouwt geen nieuw-artikel-wizard, dus er is geen data om hier
  // in te vullen. Blanco ID-placeholders, zoals in het originele sjabloon.
  for (let i = 1; i <= 26; i++) {
    rows.push([`NEW-${code}-${String(i).padStart(4, "0")}`, null, null, null, null, null, null, null, null, null, null]);
  }
  return rows;
}
