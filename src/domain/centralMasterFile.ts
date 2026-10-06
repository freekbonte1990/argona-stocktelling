import type {
  Article,
  ArticleActiveStatus,
  ArticleCountFrequency,
  ArticleLocationAssignment,
  Office,
  ProductCategory,
  StockClassification,
} from "./types";

/**
 * Centrale masterdata ("Central master data").
 *
 * Eén bestand per kantoor met de ACTUELE stamdata: kantoor, locaties,
 * productgamma's, artikelen en artikel-locatie-koppelingen. Gepubliceerd via
 * script/git/Vercel (nu) of geleverd door eBuddy (straks) — NOOIT vanuit de
 * gewone app. De app leest dit bestand enkel (via een `CentralMasterSource`) en
 * past het toe via `planCentralMasterApply` (zie `centralMasterPlan.ts`).
 *
 * Autoriteit (user-eis): de centrale master is autoritatief voor ACTUELE
 * masterdata; de historiek (`centralHistoryFile.ts`) is autoritatief voor
 * TELLINGEN. Daarom bevat de master bewust GEEN `previousCount`, geen sessies,
 * geen CountEntries en geen opmerkingen — "Vorige telling" wordt uitsluitend uit
 * de historiek afgeleid (zie `previousCount.ts`).
 *
 * Identiteitscontract (kritisch voor een latere eBuddy-adapter):
 *   Article.id         = `${officeId}:${articleNumber}`
 *   Location.id        = stabiele tekst (nooit het weergavenummer)
 *   ProductCategory.id = stabiele, globale tekst
 * Alle bestaande tellingen, historiek en koppelingen verwijzen hiernaar.
 */
export const CENTRAL_MASTER_SCHEMA_VERSION = 1;

export interface CentralMasterLocation {
  id: string;
  number: number;
  name: string;
  active: boolean;
}

export interface CentralMasterArticle {
  articleNumber: string;
  officialArticleNumber: string | null;
  idType: string | null;
  description: string;
  unit: string | null;
  supplier: string | null;
  costPrice: number | null;
  /** Verwijst naar `CentralMasterFile.categories[].id`, of `null` = niet ingedeeld. */
  categoryId: string | null;
  /** "Bronproductgroep" — historische/bron-productgroep (audit), `Article.productGroup`. */
  sourceProductGroup: string | null;
  countPeriod: ArticleCountFrequency;
  rawCountPeriod: string | null;
  status: ArticleActiveStatus;
  rawStatus: string | null;
  /** Actief in het ASSORTIMENT van dit kantoor (zie `Article.assortmentActive`). */
  assortmentActive: boolean;
  stockClassification?: StockClassification;
}

export interface CentralMasterAssignment {
  articleNumber: string;
  locationId: string;
  active: boolean;
}

export interface CentralMasterFile {
  schemaVersion: typeof CENTRAL_MASTER_SCHEMA_VERSION;
  officeId: string;
  generatedAt: string;
  /** Inhoudshash: verandert enkel als de inhoud verandert. Basis van "onveranderd" (HTTP 304). */
  revision: string;
  office: { name: string; baseDate: string | null };
  locations: CentralMasterLocation[];
  /** Bedrijfsbrede lijst (zie `ProductCategory`) — identiek over alle kantoren. */
  categories: ProductCategory[];
  articles: CentralMasterArticle[];
  assignments: CentralMasterAssignment[];
  /** Gereserveerd voor expliciete tombstones; v1: geparsed, NIET toegepast (afwezig ≠ verwijderd). */
  deletedArticleNumbers: string[];
}

/** Samenvatting van één centraal kantoor, voor het kantoor-kiezen op een nieuw toestel. */
export interface CentralOfficeSummary {
  id: string;
  name: string;
  revision: string;
  generatedAt: string;
  articleCount: number;
}

export interface CentralOfficeIndex {
  schemaVersion: typeof CENTRAL_MASTER_SCHEMA_VERSION;
  offices: CentralOfficeSummary[];
}

/**
 * Per-kantoor status van de centrale master (Dexie v9, tabel
 * `centralMasterStatus`). Een rij zonder `appliedAt` is enkel een
 * foutenregistratie (bv. de eerste poging faalde); `appliedAt !== null` =
 * "dit kantoor wordt centraal beheerd" → master-velden zijn read-only in de
 * gewone app.
 */
export interface CentralMasterStatus {
  officeId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Discrete, interne foutmelding van de laatste poging (nooit getoond als configuratie); `null` = in orde. */
  lastError: string | null;
  /** `revision` van de master die lokaal is toegepast; `null` = (nog) niet toegepast of bewust ongeldig gemaakt (Excel-import). */
  revision: string | null;
  generatedAt: string | null;
  /** Eerste/laatste toepassing van een master op dit toestel; `null` = nog nooit toegepast. */
  appliedAt: string | null;
  /** Revision die opgehaald maar UITGESTELD werd omdat er een actieve telling liep. */
  pendingRevision: string | null;
  /** "Ooit centraal" — groeit enkel (additief). Nodig om "verdwenen uit de master" te onderscheiden van "lokaal aangemaakt". */
  articleIds: string[];
  locationIds: string[];
  categoryIds: string[];
  assignmentIds: string[];
}

export function isCentrallyManaged(status: Pick<CentralMasterStatus, "appliedAt"> | undefined): boolean {
  return !!status?.appliedAt;
}

export function isCentralArticle(status: CentralMasterStatus | undefined, articleId: string): boolean {
  return isCentrallyManaged(status) && (status?.articleIds.includes(articleId) ?? false);
}

export function isCentralLocation(status: CentralMasterStatus | undefined, locationId: string): boolean {
  return isCentrallyManaged(status) && (status?.locationIds.includes(locationId) ?? false);
}

export function isCentralCategory(status: CentralMasterStatus | undefined, categoryId: string): boolean {
  return isCentrallyManaged(status) && (status?.categoryIds.includes(categoryId) ?? false);
}

/** Een lokaal aangemaakt tijdelijk artikel (TMP-…) — nooit onderdeel van de master en nooit door een sync aangeraakt. */
export function isTemporaryArticle(article: Pick<Article, "idType" | "articleNumber">): boolean {
  return article.idType === "TIJDELIJK" || /^TMP-/i.test(article.articleNumber);
}

export class CentralMasterFormatError extends Error {
  constructor(message: string) {
    super(`Ongeldige centrale masterdata: ${message}`);
    this.name = "CentralMasterFormatError";
  }
}

const FREQUENCIES: readonly ArticleCountFrequency[] = [
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
  "NOT_APPLICABLE",
  "TO_BE_DETERMINED",
];
const ARTICLE_STATUSES: readonly ArticleActiveStatus[] = ["ACTIVE", "INACTIVE"];
const STOCK_CLASSIFICATIONS: readonly StockClassification[] = ["ACTIVE", "OBSOLETE"];
const REVISION_PATTERN = /^[A-Za-z0-9._-]{4,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string, where: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new CentralMasterFormatError(`${where}: "${key}" moet ${allowEmpty ? "tekst" : "niet-lege tekst"} zijn.`);
  }
  return value;
}

function strOrNull(record: Record<string, unknown>, key: string, where: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CentralMasterFormatError(`${where}: "${key}" moet tekst of null zijn.`);
  return value;
}

function bool(record: Record<string, unknown>, key: string, where: string, fallback?: boolean): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  if (value === undefined && fallback !== undefined) return fallback;
  throw new CentralMasterFormatError(`${where}: "${key}" moet waar/onwaar zijn.`);
}

function finiteNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CentralMasterFormatError(`${where}: "${key}" moet een getal zijn.`);
  }
  return value;
}

function numberOrNull(record: Record<string, unknown>, key: string, where: string): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CentralMasterFormatError(`${where}: "${key}" moet een getal of null zijn.`);
  }
  return value;
}

function checkSchemaVersion(raw: Record<string, unknown>): void {
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== CENTRAL_MASTER_SCHEMA_VERSION) {
    throw new CentralMasterFormatError(
      typeof schemaVersion === "number" && schemaVersion > CENTRAL_MASTER_SCHEMA_VERSION
        ? `schemaVersion ${schemaVersion} is nieuwer dan deze app begrijpt (${CENTRAL_MASTER_SCHEMA_VERSION}) — de app moet eerst bijgewerkt worden.`
        : `onbekende schemaVersion (${String(schemaVersion)}).`,
    );
  }
}

function checkDate(raw: Record<string, unknown>, key: string, where: string): string {
  const value = raw[key];
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new CentralMasterFormatError(`${where}: "${key}" ontbreekt of is geen geldige datum.`);
  }
  return value;
}

/** Valideert het antwoord op `GET /api/central-master` (kantorenlijst). */
export function parseCentralOfficeIndex(raw: unknown): CentralOfficeIndex {
  if (!isRecord(raw)) throw new CentralMasterFormatError("de kantorenlijst is geen JSON-object.");
  checkSchemaVersion(raw);
  if (!Array.isArray(raw.offices)) throw new CentralMasterFormatError('"offices" moet een lijst zijn.');
  const seen = new Set<string>();
  const offices = raw.offices.map((item, index): CentralOfficeSummary => {
    const where = `offices[${index}]`;
    if (!isRecord(item)) throw new CentralMasterFormatError(`${where} is geen object.`);
    const id = str(item, "id", where);
    if (seen.has(id)) throw new CentralMasterFormatError(`${where}: dubbel kantoor "${id}".`);
    seen.add(id);
    const revision = str(item, "revision", where);
    if (!REVISION_PATTERN.test(revision)) throw new CentralMasterFormatError(`${where}: ongeldige "revision".`);
    return {
      id,
      name: str(item, "name", where),
      revision,
      generatedAt: checkDate(item, "generatedAt", where),
      articleCount: Math.max(0, Math.trunc(finiteNumber(item, "articleCount", where))),
    };
  });
  return { schemaVersion: CENTRAL_MASTER_SCHEMA_VERSION, offices };
}

/**
 * Valideert (strikt, alles-of-niets) en normaliseert een ruw JSON-resultaat tot
 * een `CentralMasterFile`. Onbekende extra velden worden genegeerd (forward-compat
 * binnen dezelfde `schemaVersion`); een HOGERE `schemaVersion` wordt geweigerd.
 * Alle kruisverwijzingen (categorie, locatie, artikel) worden gecontroleerd, zodat
 * een half-kapotte master NOOIT gedeeltelijk lokaal terechtkomt.
 */
export function parseCentralMasterFile(raw: unknown, expectedOfficeId?: string): CentralMasterFile {
  if (!isRecord(raw)) throw new CentralMasterFormatError("het bestand is geen JSON-object.");
  checkSchemaVersion(raw);

  const officeId = str(raw, "officeId", "bestand");
  if (expectedOfficeId !== undefined && officeId !== expectedOfficeId) {
    throw new CentralMasterFormatError(`het bestand hoort bij kantoor "${officeId}", niet bij "${expectedOfficeId}".`);
  }
  const generatedAt = checkDate(raw, "generatedAt", "bestand");
  const revision = str(raw, "revision", "bestand");
  if (!REVISION_PATTERN.test(revision)) throw new CentralMasterFormatError('"revision" heeft een ongeldige vorm.');

  const officeRaw = raw.office;
  if (!isRecord(officeRaw)) throw new CentralMasterFormatError('"office" ontbreekt.');
  const office = { name: str(officeRaw, "name", "office"), baseDate: strOrNull(officeRaw, "baseDate", "office") };

  // Locaties
  if (!Array.isArray(raw.locations)) throw new CentralMasterFormatError('"locations" moet een lijst zijn.');
  const locationIds = new Set<string>();
  const locations = raw.locations.map((item, index): CentralMasterLocation => {
    const where = `locations[${index}]`;
    if (!isRecord(item)) throw new CentralMasterFormatError(`${where} is geen object.`);
    const id = str(item, "id", where);
    if (locationIds.has(id)) throw new CentralMasterFormatError(`${where}: dubbele locatie-id "${id}".`);
    locationIds.add(id);
    const number = finiteNumber(item, "number", where);
    if (!Number.isInteger(number) || number < 1) {
      throw new CentralMasterFormatError(`${where}: "number" moet een geheel getal ≥ 1 zijn.`);
    }
    return { id, number, name: str(item, "name", where), active: bool(item, "active", where) };
  });
  if (!locations.some((l) => l.active)) {
    throw new CentralMasterFormatError("er moet minstens één actieve locatie zijn.");
  }

  // Productgamma's
  if (!Array.isArray(raw.categories)) throw new CentralMasterFormatError('"categories" moet een lijst zijn.');
  const categoryIds = new Set<string>();
  const categoryNames = new Set<string>();
  const categories = raw.categories.map((item, index): ProductCategory => {
    const where = `categories[${index}]`;
    if (!isRecord(item)) throw new CentralMasterFormatError(`${where} is geen object.`);
    const id = str(item, "id", where);
    const name = str(item, "name", where);
    if (categoryIds.has(id)) throw new CentralMasterFormatError(`${where}: dubbele categorie-id "${id}".`);
    const normalizedName = name.trim().toLowerCase();
    if (categoryNames.has(normalizedName)) throw new CentralMasterFormatError(`${where}: dubbele categorienaam "${name}".`);
    categoryIds.add(id);
    categoryNames.add(normalizedName);
    return { id, name, sortOrder: finiteNumber(item, "sortOrder", where), active: bool(item, "active", where) };
  });

  // Artikelen
  if (!Array.isArray(raw.articles)) throw new CentralMasterFormatError('"articles" moet een lijst zijn.');
  const articleNumbers = new Set<string>();
  const articles = raw.articles.map((item, index): CentralMasterArticle => {
    const where = `articles[${index}]`;
    if (!isRecord(item)) throw new CentralMasterFormatError(`${where} is geen object.`);
    const articleNumber = str(item, "articleNumber", where);
    if (articleNumbers.has(articleNumber)) {
      throw new CentralMasterFormatError(`${where}: dubbel artikelnummer "${articleNumber}".`);
    }
    articleNumbers.add(articleNumber);

    const countPeriod = str(item, "countPeriod", where) as ArticleCountFrequency;
    if (!FREQUENCIES.includes(countPeriod)) {
      throw new CentralMasterFormatError(`${where}: onbekende "countPeriod" (${countPeriod}).`);
    }
    const status = str(item, "status", where) as ArticleActiveStatus;
    if (!ARTICLE_STATUSES.includes(status)) {
      throw new CentralMasterFormatError(`${where}: onbekende "status" (${status}).`);
    }
    const categoryId = strOrNull(item, "categoryId", where);
    if (categoryId !== null && !categoryIds.has(categoryId)) {
      throw new CentralMasterFormatError(`${where}: onbekende "categoryId" (${categoryId}).`);
    }
    const costPrice = numberOrNull(item, "costPrice", where);
    if (costPrice !== null && costPrice < 0) {
      throw new CentralMasterFormatError(`${where}: "costPrice" mag niet negatief zijn.`);
    }
    const article: CentralMasterArticle = {
      articleNumber,
      officialArticleNumber: strOrNull(item, "officialArticleNumber", where),
      idType: strOrNull(item, "idType", where),
      description: str(item, "description", where, true),
      unit: strOrNull(item, "unit", where),
      supplier: strOrNull(item, "supplier", where),
      costPrice,
      categoryId,
      sourceProductGroup: strOrNull(item, "sourceProductGroup", where),
      countPeriod,
      rawCountPeriod: strOrNull(item, "rawCountPeriod", where),
      status,
      rawStatus: strOrNull(item, "rawStatus", where),
      assortmentActive: bool(item, "assortmentActive", where, true),
    };
    if (item.stockClassification !== undefined && item.stockClassification !== null) {
      const classification = item.stockClassification as StockClassification;
      if (!STOCK_CLASSIFICATIONS.includes(classification)) {
        throw new CentralMasterFormatError(`${where}: onbekende "stockClassification" (${String(classification)}).`);
      }
      article.stockClassification = classification;
    }
    return article;
  });

  // Koppelingen
  if (!Array.isArray(raw.assignments)) throw new CentralMasterFormatError('"assignments" moet een lijst zijn.');
  const assignmentKeys = new Set<string>();
  const assignments = raw.assignments.map((item, index): CentralMasterAssignment => {
    const where = `assignments[${index}]`;
    if (!isRecord(item)) throw new CentralMasterFormatError(`${where} is geen object.`);
    const articleNumber = str(item, "articleNumber", where);
    const locationId = str(item, "locationId", where);
    if (!articleNumbers.has(articleNumber)) {
      throw new CentralMasterFormatError(`${where}: onbekend artikel "${articleNumber}".`);
    }
    if (!locationIds.has(locationId)) {
      throw new CentralMasterFormatError(`${where}: onbekende locatie "${locationId}".`);
    }
    const key = `${articleNumber}|${locationId}`;
    if (assignmentKeys.has(key)) throw new CentralMasterFormatError(`${where}: dubbele koppeling ${articleNumber} ↔ ${locationId}.`);
    assignmentKeys.add(key);
    return { articleNumber, locationId, active: bool(item, "active", where, true) };
  });

  const deletedRaw = raw.deletedArticleNumbers ?? [];
  if (!Array.isArray(deletedRaw) || deletedRaw.some((n) => typeof n !== "string" || n === "")) {
    throw new CentralMasterFormatError('"deletedArticleNumbers" moet een lijst met niet-lege tekst zijn.');
  }

  return {
    schemaVersion: CENTRAL_MASTER_SCHEMA_VERSION,
    officeId,
    generatedAt,
    revision,
    office,
    locations,
    categories,
    articles,
    assignments,
    deletedArticleNumbers: deletedRaw as string[],
  };
}

/** Het volledige, door `applyCentralMaster` in ÉÉN transactie weg te schrijven resultaat van een master-toepassing. */
export interface CentralMasterApplyPlan {
  office: Office;
  /** Enkel nieuwe of gewijzigde artikelen van dit kantoor. */
  articles: Article[];
  /** Enkel nieuwe of gewijzigde koppelingen. */
  assignments: ArticleLocationAssignment[];
  categories: ProductCategory[];
  categoryIdsToDelete: string[];
  /** Artikelen van ANDERE kantoren waarvan enkel een lokaal-willekeurig `categoryId` werd herleid naar het centrale id. */
  otherOfficeArticles: Article[];
  importMeta: { officeId: string; sourceFileName: string; importedAt: string };
  status: CentralMasterStatus;
  /** Bootstrap: dit kantoor meteen als geselecteerd kantoor bewaren. */
  selectOffice: boolean;
  summary: CentralMasterApplySummary;
}

export interface CentralMasterApplySummary {
  articlesAdded: number;
  articlesUpdated: number;
  articlesUnchanged: number;
  articlesDeactivated: number;
  localArticlesKept: number;
  locationsAdded: number;
  locationsUpdated: number;
  locationsDeactivated: number;
  assignmentsWritten: number;
  categoriesWritten: number;
  categoriesRemapped: number;
}
