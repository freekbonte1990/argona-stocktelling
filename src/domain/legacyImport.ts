import { slugify } from "../shared/ids";
import { REQUIRED_LEGACY_PERIODS, type LegacyPeriod } from "./legacyPeriods";
import { historyEntryKey, type StockHistoryEntry } from "./stockSnapshot";
import type { Article } from "./types";

/**
 * Sprint 3.3 §3 (legacy historische stockimport): PURE domeinlogica voor het
 * omzetten van een reeds ruw ingelezen historisch stockbestand (van vóór
 * deze app) naar de bestaande domeinmodellen — nooit rechtstreeks Excel/xlsx
 * hier, dat blijft de taak van de adapter (`adapters/excel/parseLegacyStock*.ts`).
 *
 * Bewuste, letterlijke uitvoering van de harde regels uit de spec:
 *   - ALTIJD de oorspronkelijke historische kostprijs, nooit een
 *     afgewaardeerde/herwaarderings-boekwaarde (de adapter kiest welke
 *     brontekst-kolom dat is per bestand/periode — dit bestand rekent hier
 *     nooit zelf iets "terug", het leest enkel over wat is aangeleverd);
 *   - stockwaarde = hoeveelheid × oorspronkelijke kostprijs, ALTIJD hier
 *     herberekend (nooit een mogelijk verouderde/gebroken brontekst-
 *     waardekolom vertrouwen — spec: "Broken formulas / #REF! / old
 *     comparison formulas must not be trusted");
 *   - matching-prioriteit: (1) een aanwezig artikelnummer is ALTIJD de
 *     betrouwbare identiteit (ongeacht of het huidige mastermodel dat
 *     nummer nog kent), (2) zonder artikelnummer: genormaliseerde exacte
 *     omschrijving tegen het HUIDIGE mastermodel, (3) anders onopgelost/
 *     manuele review — NOOIT fuzzy automatisch samenvoegen;
 *   - een oud artikel dat niet meer in het huidige mastermodel voorkomt
 *     blijft gewoon importeerbaar als historisch/inactief artikel (nooit
 *     overgeslagen).
 */

export interface LegacyStockRow {
  /** Canonieke periodesleutel — zie `REQUIRED_LEGACY_PERIODS` in `legacyPeriods.ts`, bv. "2025-03-31". */
  periodKey: string;
  /** Historische/bron-productgroep, indien beschikbaar. */
  sourceProductGroup: string | null;
  /** Historische omschrijving zoals aangetroffen in de bron. */
  description: string;
  /** Brontekst-artikelnummer, indien aanwezig — `null` wanneer de bron er geen heeft. */
  articleNumber: string | null;
  /** ALTIJD de oorspronkelijke historische kostprijs — nooit een afgewaardeerde waarde. */
  originalCostPrice: number | null;
  quantity: number | null;
  /** `null` = "onbekend" (geen betrouwbare bronkolom voor deze periode) — nooit verzonnen. */
  obsolete: boolean | null;
  /** Ruwe brontekst voor traceerbaarheid/anomaliedetectie (bv. sheetnaam + rijnummer). */
  sourceRef: string;
}

export type LegacyMatchMethod = "ARTICLE_NUMBER" | "NORMALIZED_DESCRIPTION" | "UNRESOLVED";

export interface LegacyMatchResult {
  method: LegacyMatchMethod;
  /** Het overeenkomende HUIDIGE artikel, indien gevonden — nooit fuzzy. */
  matchedArticle: Article | null;
  /** Het `Article.id` waaraan deze legacy-rij toegewezen wordt. */
  resolvedArticleId: string;
}

/** Genormaliseerd voor exacte (nooit fuzzy) omschrijving-matching. */
export function normalizeDescriptionForMatching(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Matcht één legacy-rij tegen het HUIDIGE mastermodel van dit kantoor,
 * volgens de vaste prioriteit uit de spec. Een aanwezig artikelnummer is
 * ALTIJD de gekozen identiteit (methode ARTICLE_NUMBER) — ook wanneer dat
 * nummer niet (meer) in het huidige mastermodel voorkomt: dat is precies het
 * "oud artikel, nog steeds betrouwbaar geïdentificeerd, gewoon niet meer
 * actief"-geval, geen onopgeloste rij. Enkel wanneer de bron GEEN
 * artikelnummer heeft, valt dit terug op genormaliseerde exacte
 * omschrijving, en pas als ook dat niets oplevert: onopgelost.
 */
export function matchLegacyRow(
  row: Pick<LegacyStockRow, "articleNumber" | "description">,
  officeId: string,
  currentArticlesByNumber: ReadonlyMap<string, Article>,
  currentArticlesByNormalizedDescription: ReadonlyMap<string, Article>,
): LegacyMatchResult {
  const articleNumber = row.articleNumber?.trim();
  if (articleNumber) {
    return {
      method: "ARTICLE_NUMBER",
      matchedArticle: currentArticlesByNumber.get(articleNumber) ?? null,
      resolvedArticleId: `${officeId}:${articleNumber}`,
    };
  }

  const normalizedDescription = normalizeDescriptionForMatching(row.description);
  const matchedArticle = currentArticlesByNormalizedDescription.get(normalizedDescription) ?? null;
  if (matchedArticle) {
    return { method: "NORMALIZED_DESCRIPTION", matchedArticle, resolvedArticleId: matchedArticle.id };
  }

  // Onopgelost: geen fuzzy auto-merge — krijgt een eigen, STABIELE
  // gesynthetiseerde identiteit (afgeleid van de genormaliseerde
  // omschrijving), zodat een herimport van dezelfde rij opnieuw exact
  // hetzelfde ID oplevert (idempotent), zonder ooit met een bestaand
  // artikel te botsen (het "LEGACY-"-voorvoegsel bestaat nooit in een
  // normaal Excel-artikelnummer).
  return {
    method: "UNRESOLVED",
    matchedArticle: null,
    resolvedArticleId: `${officeId}:LEGACY-${slugify(normalizedDescription || row.description)}`,
  };
}

/** Bouwt de opzoekindexen die `matchLegacyRow` nodig heeft — één keer per import, niet per rij. */
export function buildCurrentArticleIndexes(currentArticles: Article[]): {
  byNumber: Map<string, Article>;
  byNormalizedDescription: Map<string, Article>;
} {
  const byNumber = new Map<string, Article>();
  const byNormalizedDescription = new Map<string, Article>();
  for (const article of currentArticles) {
    byNumber.set(article.articleNumber, article);
    const normalized = normalizeDescriptionForMatching(article.description);
    // Bij een dubbele omschrijving wint het EERST aangetroffen artikel —
    // een botsing hier betekent sowieso dat omschrijving-matching voor die
    // tekst niet betrouwbaar genoeg is, maar we willen nooit crashen op
    // dubbele huidige omschrijvingen.
    if (!byNormalizedDescription.has(normalized)) {
      byNormalizedDescription.set(normalized, article);
    }
  }
  return { byNumber, byNormalizedDescription };
}

/**
 * Bouwt, voor een rij zonder bestaand huidig match, het nieuwe historische/
 * inactieve `Article`-record (spec: "oude artikelen die niet meer in het
 * huidige mastermodel voorkomen moeten nog steeds importeerbaar zijn als
 * historisch/inactief artikel"). `null` wanneer de rij WEL al matchte (dan is
 * er niets nieuws te maken — de bestaande, levende `Article` blijft
 * ongewijzigd, spec: legacy-import overschrijft nooit levende mastergegevens).
 *
 * `assortmentActive: false` + `status: "INACTIVE"` samen: nooit in een
 * nieuwe telling (spec §1/§2), en meteen zichtbaar als "niet meer actief" in
 * elk artikelenoverzicht — puur informatief, verandert niets aan de
 * gecentraliseerde count-scope-regel zelf (die leest uitsluitend
 * `assortmentActive`, zie `domain/countScope.ts`).
 */
export function buildLegacyOnlyArticle(
  row: LegacyStockRow,
  officeId: string,
  match: LegacyMatchResult,
): Article | null {
  if (match.matchedArticle) return null;

  const articleNumber = match.resolvedArticleId.slice(`${officeId}:`.length);
  return {
    id: match.resolvedArticleId,
    officeId,
    articleNumber,
    officialArticleNumber: null,
    idType: "LEGACY",
    description: row.description,
    productGroup: row.sourceProductGroup,
    supplier: null,
    unit: null,
    costPrice: row.originalCostPrice,
    rawCountPeriod: null,
    countPeriod: "NOT_APPLICABLE",
    // BEWUST één van de erkende "niet-actief"-markeringen (zie
    // `domain/frequency.ts#INACTIVE_MARKERS`/`ARTICLE_STATUS_OPTIONS`), NOOIT
    // een eigen vrije tekst ("LEGACY_IMPORT") — de Excel-export schrijft enkel
    // `rawStatus` weg (kolom "Artikelstatus"), en een herimport herberekent
    // `status` daar altijd opnieuw uit via `normalizeArticleStatus`. Een
    // onherkende ruwe tekst zou dit artikel bij een latere export/herimport-
    // cyclus stilzwijgend terug ACTIVE laten worden — exact het soort
    // "count-scope-regel stilletjes ondermijnd" dat de spec verbiedt.
    rawStatus: "NON-ACTIEF",
    status: "INACTIVE",
    previousCount: null,
    sourceRow: null,
    assortmentActive: false,
  };
}

/** Legacy-tellingnamen krijgen een eigen, herkenbaar naamgevingsschema — botst per constructie nooit met de app's eigen "2026-09 Maand"-conventie. */
export function legacySessionName(periodLabel: string): string {
  return `LEGACY ${periodLabel}`;
}

/**
 * Sprint 3.3 §1 (legacy Analyse/Vergelijken): omgekeerde opzoeking van
 * `legacySessionName` — nodig zodra `ComparisonService` een reeds bewaarde
 * `StockHistoryEntry.sessionName` (bv. "LEGACY 01/09/2026") terug moet
 * herleiden tot zijn `LegacyPeriod` (periodesleutel/ISO-datum), zonder een
 * eigen tweede parsing-/matchingschema te verzinnen.
 */
export const LEGACY_PERIOD_BY_SESSION_NAME: ReadonlyMap<string, LegacyPeriod> = new Map(
  REQUIRED_LEGACY_PERIODS.map((period) => [legacySessionName(period.label), period]),
);

/**
 * Bouwt de `StockHistoryEntry` voor één legacy-rij — status ALTIJD "LEGACY"
 * (nooit GETELD/OVERGENOMEN, spec: "geen normale CountSession-semantiek
 * fabriceren"), `previousCount`/`locationNames` altijd leeg/onbekend (een
 * legacy-punt draagt nooit bij aan `Article.previousCount`, zie
 * `CountSessionService#finalize`/`domain/sessionDeletion.ts`, die uitsluitend
 * bevroren `StockSnapshot`s van echte sessies lezen). Stockwaarde wordt hier
 * NIET meegegeven (`differenceAmount`/`differenceQuantity` zijn hier
 * betekenisloos — geen "vorige telling" om mee te vergelijken); de UI
 * (`mergeArticleHistory`) berekent `stockValue` zelf, puur uit `totalCount ×
 * costPrice`.
 */
export function buildLegacyHistoryEntry(
  row: LegacyStockRow,
  periodLabel: string,
  isoDate: string,
  match: LegacyMatchResult,
): StockHistoryEntry {
  const articleNumber = match.resolvedArticleId.slice(match.resolvedArticleId.indexOf(":") + 1);
  return {
    countDate: isoDate,
    sessionType: "FULL",
    sessionName: legacySessionName(periodLabel),
    articleId: match.resolvedArticleId,
    articleNumber,
    description: row.description,
    totalCount: row.quantity,
    previousCount: null,
    differenceQuantity: null,
    costPrice: row.originalCostPrice,
    differenceAmount: null,
    status: "LEGACY",
    locationNames: [],
    source: "LEGACY_IMPORT",
    // Frozen fact (Sprint 3.3 §1): de HISTORISCHE/bron-productgroep van deze
    // rij, nooit de eventueel intussen gewijzigde huidige `Article.productGroup`
    // — zie `StockHistoryEntry.sourceProductGroup`s eigen documentatie.
    sourceProductGroup: row.sourceProductGroup,
    // Expliciete bronvlag "OBSOLETE?" bevroren in de historische regel
    // (JA* -> OBSOLETE, NEE/NEEN -> ACTIVE, onbekend -> niet gezet).
    ...(row.obsolete === true ? { stockClassification: "OBSOLETE" as const } : {}),
    ...(row.obsolete === false ? { stockClassification: "ACTIVE" as const } : {}),
  };
}

export interface LegacyImportAnomaly {
  periodKey: string;
  description: string;
  reason: string;
}

/**
 * Sprint 3.3 §2 (exacte rijreconciliatie — data-kwaliteitscontrole): elke
 * brondata-rij eindigt in EXACT ÉÉN van deze drie uitkomsten, bepaald door
 * wat er WERKELIJK met de rij gebeurt (niet door de matching-METHODE, zie
 * de uitleg bij `LegacyImportPreview` hieronder):
 *   - `MATCHED_EXISTING_ARTICLE` — de rij matcht een reeds bestaand, LEVEND
 *     artikel in het huidige mastermodel (`match.matchedArticle !== null`);
 *   - `NEW_HISTORICAL_ARTICLE` — er bestaat geen levend artikel voor deze
 *     rij, dus wordt (of werd al, bij een vorige rij) een nieuw historisch/
 *     inactief artikel aangemaakt (`buildLegacyOnlyArticle`);
 *   - `REJECTED` — de rij kon niet verwerkt worden en is expliciet
 *     overgeslagen, met een vastgelegde reden (`LegacyImportPreview.rejectedRows`)
 *     — bv. een onbekende periodesleutel. Dit gebeurt NOOIT stilzwijgend.
 */
export type LegacyRowOutcome = "MATCHED_EXISTING_ARTICLE" | "NEW_HISTORICAL_ARTICLE" | "REJECTED";

export interface LegacyImportRejection {
  periodKey: string;
  description: string;
  reason: string;
}

export interface LegacyImportPeriodSummary {
  periodKey: string;
  periodLabel: string;
  rowCount: number;
  /** Door MATCH-METHODE (informatief) — zie `matchLegacyRow`. Een rij hier kan alsnog een NIEUW historisch artikel opleveren (bv. ARTICLE_NUMBER zonder levend artikel), zie de uitkomst-velden hieronder voor de exacte reconciliatie. */
  matchedByArticleNumber: number;
  matchedByDescription: number;
  unresolvedCount: number;
  /**
   * Door WERKELIJKE UITKOMST (Sprint 3.3 §2 — exacte reconciliatie): deze
   * drie tellen ALTIJD exact op tot `rowCount` voor deze periode, en hun
   * som over alle periodes tot `LegacyImportPreview.totalRows`.
   */
  matchedExistingArticleCount: number;
  newHistoricalArticleRowCount: number;
  rejectedRowCount: number;
  totalOriginalStockValue: number;
}

export interface LegacyImportPreview {
  officeId: string;
  periods: LegacyImportPeriodSummary[];
  totalRows: number;
  /** Door MATCH-METHODE (informatief, backward-compatible met de bestaande UI-tekst) — zie `LegacyImportPeriodSummary` hierboven voor de nuance. */
  totalMatched: number;
  totalUnresolved: number;
  /**
   * Sprint 3.3 §2 — exacte rijreconciliatie, door WERKELIJKE UITKOMST: elke
   * bron-rij is EXACT één van deze drie, en hun som is ALTIJD gelijk aan
   * `totalRows` (afgedwongen door een dedicated test, zie
   * `legacyImport.test.ts`) — geen enkele rij mag stilzwijgend verdwijnen.
   */
  totalMatchedExistingArticle: number;
  totalNewHistoricalArticleRows: number;
  totalRejectedRows: number;
  /** Elke expliciet overgeslagen rij, met de reden — nooit een stille skip. */
  rejectedRows: LegacyImportRejection[];
  totalOriginalStockValue: number;
  anomalies: LegacyImportAnomaly[];
  /**
   * Aantal brondata-rijen dat, binnen dezelfde periode, naar hetzelfde
   * artikel resolveert als een EERDERE rij (bv. hetzelfde artikelnummer twee
   * keer in dezelfde sheet, of twee onopgeloste rijen met identieke
   * genormaliseerde omschrijving) — ontdekt via een end-to-end-test met de
   * echte brondata (Sprint 3.3 §7). `historyEntries`/`saveStockHistoryEntries`
   * dedupliceren zulke botsingen altijd correct (laatste rij wint, per
   * (periode, artikel) — zie `stockSnapshot.ts#mergeHistoryEntries`), dus dit
   * verliest NOOIT data op een crashende manier — maar de spec vraagt
   * expliciet transparantie over wat de bron zelf dubbelzinnig aanlevert
   * ("rapporteer wat nog ontbreekt/ambigu is"), vandaar hier zichtbaar
   * gemaakt i.p.v. stilzwijgend opgelost.
   */
  duplicateRowCount: number;
}

export interface LegacyImportPlan {
  preview: LegacyImportPreview;
  /** Nieuwe historische/inactieve artikelen (gededupliceerd op id — spec: idempotent). */
  newArticles: Article[];
  /**
   * Eén `StockHistoryEntry` per rij, over alle periodes heen — VOOR
   * deduplicatie (zie `duplicateRowCount` hierboven). De aanroeper
   * (`LegacyImportService`) voegt dit samen via de bestaande
   * `mergeHistoryEntries`, die dubbele (periode, artikel)-sleutels binnen
   * deze lijst zelf ook al correct dedupliceert — `historyEntries.length`
   * hier is dus NIET altijd gelijk aan het aantal daadwerkelijk bewaarde
   * regels voor deze periode-batch.
   */
  historyEntries: StockHistoryEntry[];
}

function detectAnomalies(row: LegacyStockRow): string[] {
  const reasons: string[] = [];
  if (row.quantity === null) reasons.push("hoeveelheid onbekend/ontbrekend");
  if (row.originalCostPrice === null) reasons.push("oorspronkelijke kostprijs onbekend/ontbrekend");
  if (row.quantity !== null && row.quantity < 0) reasons.push(`negatieve hoeveelheid (${row.quantity})`);
  return reasons;
}

/**
 * Bouwt het volledige, PURE importplan (preview + de daadwerkelijk te
 * persisteren wijzigingen) uit reeds ruw ingelezen legacy-rijen — de enige
 * functie die de adapter/service hoeven aan te roepen. Idempotent: twee keer
 * hetzelfde `rows`-invoer levert exact dezelfde `newArticles`/`historyEntries`
 * op (zelfde ID's/sleutels), dus een herimport overschrijft gewoon dezelfde
 * records opnieuw i.p.v. te dupliceren (de aanroeper gebruikt de bestaande
 * upsert-semantiek van `saveArticles`/`saveStockHistoryEntries`).
 */
export function buildLegacyImportPlan(
  rows: LegacyStockRow[],
  officeId: string,
  periodLabelsByKey: ReadonlyMap<string, { label: string; isoDate: string }>,
  currentArticles: Article[],
): LegacyImportPlan {
  const { byNumber, byNormalizedDescription } = buildCurrentArticleIndexes(currentArticles);

  const newArticlesById = new Map<string, Article>();
  const historyEntries: StockHistoryEntry[] = [];
  const anomalies: LegacyImportAnomaly[] = [];
  const rejectedRows: LegacyImportRejection[] = [];
  const seenHistoryKeys = new Set<string>();
  let duplicateRowCount = 0;
  const perPeriod = new Map<
    string,
    {
      rowCount: number;
      matchedByArticleNumber: number;
      matchedByDescription: number;
      unresolvedCount: number;
      matchedExistingArticleCount: number;
      newHistoricalArticleRowCount: number;
      rejectedRowCount: number;
      stockValue: number;
    }
  >();

  function statsFor(periodKey: string) {
    const stats = perPeriod.get(periodKey) ?? {
      rowCount: 0,
      matchedByArticleNumber: 0,
      matchedByDescription: 0,
      unresolvedCount: 0,
      matchedExistingArticleCount: 0,
      newHistoricalArticleRowCount: 0,
      rejectedRowCount: 0,
      stockValue: 0,
    };
    perPeriod.set(periodKey, stats);
    return stats;
  }

  for (const row of rows) {
    const period = periodLabelsByKey.get(row.periodKey);
    const stats = statsFor(row.periodKey);
    stats.rowCount += 1;

    if (!period) {
      // Sprint 3.3 §2: een onbekende periodesleutel mag nooit stilzwijgend
      // verdwijnen — dit is nu een EXPLICIETE, geteld-en-gerapporteerde
      // uitkomst (REJECTED), i.p.v. een stille `continue`. Zou in de
      // praktijk nooit mogen voorkomen (de adapter kent enkel de 7 vereiste
      // periodesleutels), maar als het toch gebeurt, blijft de rij-som
      // exact kloppen.
      stats.rejectedRowCount += 1;
      rejectedRows.push({
        periodKey: row.periodKey,
        description: row.description,
        reason: `onbekende periodesleutel "${row.periodKey}" (komt niet overeen met één van de 7 vereiste legacy-periodes)`,
      });
      continue;
    }

    const match = matchLegacyRow(row, officeId, byNumber, byNormalizedDescription);
    const newArticle = buildLegacyOnlyArticle(row, officeId, match);
    if (newArticle) {
      stats.newHistoricalArticleRowCount += 1;
      if (!newArticlesById.has(newArticle.id)) {
        newArticlesById.set(newArticle.id, newArticle);
      }
    } else {
      stats.matchedExistingArticleCount += 1;
    }

    const historyEntry = buildLegacyHistoryEntry(row, period.label, period.isoDate, match);
    const key = historyEntryKey(historyEntry);
    if (seenHistoryKeys.has(key)) {
      duplicateRowCount += 1;
      anomalies.push({
        periodKey: row.periodKey,
        description: row.description,
        reason: `dubbele brondata-rij voor hetzelfde artikel in dezelfde periode (${period.label}) — laatste rij wint`,
      });
    }
    seenHistoryKeys.add(key);
    historyEntries.push(historyEntry);

    if (match.method === "ARTICLE_NUMBER") stats.matchedByArticleNumber += 1;
    else if (match.method === "NORMALIZED_DESCRIPTION") stats.matchedByDescription += 1;
    else stats.unresolvedCount += 1;
    if (row.quantity !== null && row.originalCostPrice !== null) {
      stats.stockValue += row.quantity * row.originalCostPrice;
    }

    for (const reason of detectAnomalies(row)) {
      anomalies.push({ periodKey: row.periodKey, description: row.description, reason });
    }
  }

  const periods: LegacyImportPeriodSummary[] = Array.from(perPeriod.entries()).map(([periodKey, stats]) => ({
    periodKey,
    periodLabel: periodLabelsByKey.get(periodKey)?.label ?? periodKey,
    rowCount: stats.rowCount,
    matchedByArticleNumber: stats.matchedByArticleNumber,
    matchedByDescription: stats.matchedByDescription,
    unresolvedCount: stats.unresolvedCount,
    matchedExistingArticleCount: stats.matchedExistingArticleCount,
    newHistoricalArticleRowCount: stats.newHistoricalArticleRowCount,
    rejectedRowCount: stats.rejectedRowCount,
    totalOriginalStockValue: stats.stockValue,
  }));
  periods.sort((a, b) => a.periodKey.localeCompare(b.periodKey));

  const preview: LegacyImportPreview = {
    officeId,
    periods,
    totalRows: rows.length,
    totalMatched: periods.reduce((sum, p) => sum + p.matchedByArticleNumber + p.matchedByDescription, 0),
    totalUnresolved: periods.reduce((sum, p) => sum + p.unresolvedCount, 0),
    totalMatchedExistingArticle: periods.reduce((sum, p) => sum + p.matchedExistingArticleCount, 0),
    totalNewHistoricalArticleRows: periods.reduce((sum, p) => sum + p.newHistoricalArticleRowCount, 0),
    totalRejectedRows: rejectedRows.length,
    rejectedRows,
    totalOriginalStockValue: periods.reduce((sum, p) => sum + p.totalOriginalStockValue, 0),
    anomalies,
    duplicateRowCount,
  };

  return { preview, newArticles: Array.from(newArticlesById.values()), historyEntries };
}
