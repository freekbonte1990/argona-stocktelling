import { createHash } from "node:crypto";
import { createExcelStockSourceFromBuffer } from "../src/adapters/excel/ExcelStockSource";
import {
  CENTRAL_MASTER_SCHEMA_VERSION,
  isTemporaryArticle,
  parseCentralMasterFile,
  type CentralMasterArticle,
  type CentralMasterAssignment,
  type CentralMasterFile,
  type CentralMasterLocation,
} from "../src/domain/centralMasterFile";
import type { ProductCategory } from "../src/domain/types";

export interface MasterPublicationInput {
  /** Inhoud van een Argona-Excelbestand (export uit de app, of het originele masterbestand). */
  buffer: ArrayBuffer;
  fileName: string;
  generatedAt: string;
  /** Lokaal aangemaakte TMP-artikelen horen niet in de master — standaard worden ze weggelaten. */
  includeTemporary?: boolean;
  /** De reeds gepubliceerde masters van ANDERE kantoren (voor een consistente, globale productgamma-lijst). */
  otherOffices?: CentralMasterFile[];
}

export interface MasterPublicationResult {
  file: CentralMasterFile;
  stats: {
    officeId: string;
    articles: number;
    locations: number;
    assignments: number;
    categories: number;
    temporaryExcluded: number;
    unknownCategoryReferences: number;
    categoriesAlignedWithOtherOffices: number;
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Inhoudshash (zonder `generatedAt`): zelfde inhoud = zelfde revision, dus geen nodeloze herpublicatie/herdownload. */
export function computeMasterRevision(content: Omit<CentralMasterFile, "generatedAt" | "revision">): string {
  const canonical = JSON.stringify({
    officeId: content.officeId,
    office: content.office,
    locations: content.locations,
    categories: content.categories,
    articles: content.articles,
    assignments: content.assignments,
    deletedArticleNumbers: content.deletedArticleNumbers,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Brengt de productgamma's van dit kantoor in lijn met de reeds gepubliceerde
 * kantoren: één productgamma ("Kabels") heeft over alle kantoren hetzelfde id.
 * Een export van een ander toestel heeft voor dezelfde NAAM een ander
 * willekeurig id — dat wordt hier herleid naar het reeds gepubliceerde id
 * (de reeds gepubliceerde definitie wint). Een zelfde id met een andere naam is
 * een echte conflictfout. Het resultaat bevat ook de globale categorieën die dit
 * kantoor zelf niet kende, zodat elk bestand de volledige bedrijfsbrede lijst draagt.
 */
export function alignCategories(
  own: ProductCategory[],
  others: CentralMasterFile[],
): { categories: ProductCategory[]; idMap: Map<string, string>; aligned: number } {
  const published = new Map<string, ProductCategory>();
  for (const office of others) for (const c of office.categories) if (!published.has(c.id)) published.set(c.id, c);
  const publishedByName = new Map<string, ProductCategory>();
  for (const c of published.values()) publishedByName.set(normalizeName(c.name), c);

  const idMap = new Map<string, string>();
  const result = new Map<string, ProductCategory>();
  let aligned = 0;
  for (const category of own) {
    const sameId = published.get(category.id);
    if (sameId && normalizeName(sameId.name) !== normalizeName(category.name)) {
      throw new Error(
        `Productgamma-conflict: id "${category.id}" heet bij een ander kantoor "${sameId.name}" maar hier "${category.name}".`,
      );
    }
    const sameName = publishedByName.get(normalizeName(category.name));
    if (sameName && sameName.id !== category.id) {
      idMap.set(category.id, sameName.id);
      aligned += 1;
      result.set(sameName.id, sameName);
    } else {
      result.set(category.id, sameId ?? category);
    }
  }
  for (const c of published.values()) if (!result.has(c.id)) result.set(c.id, c);
  const categories = Array.from(result.values()).sort((a, b) => a.sortOrder - b.sortOrder || compare(a.id, b.id));
  return { categories, idMap, aligned };
}

/**
 * Bouwt (zonder iets weg te schrijven) het te publiceren masterbestand uit een
 * Argona-Excelbestand. Pure functie → volledig testbaar; het CLI-script
 * (`publish-central-master.ts`) doet enkel het bestandsbeheer errond.
 *
 * Bewust NIET in de master: `previousCount`, tellingen, sessies, opmerkingen,
 * TMP-artikelen (tenzij `includeTemporary`).
 */
export async function buildMasterPublication(input: MasterPublicationInput): Promise<MasterPublicationResult> {
  const source = createExcelStockSourceFromBuffer(input.buffer, input.fileName);
  const office = await source.loadOffice();
  const allArticles = await source.loadArticles(office);
  const assignmentsRaw = (await source.loadArticleLocationAssignments?.()) ?? [];
  const categoriesRaw = (await source.loadProductCategories?.()) ?? [];

  const included = input.includeTemporary ? allArticles : allArticles.filter((a) => !isTemporaryArticle(a));
  const temporaryExcluded = allArticles.length - included.length;

  const { categories, idMap, aligned } = alignCategories(categoriesRaw, input.otherOffices ?? []);
  const categoryIds = new Set(categories.map((c) => c.id));

  let unknownCategoryReferences = 0;
  const articles: CentralMasterArticle[] = included
    .map((a): CentralMasterArticle => {
      const mapped = a.categoryId ? (idMap.get(a.categoryId) ?? a.categoryId) : null;
      const categoryId = mapped && categoryIds.has(mapped) ? mapped : null;
      if (mapped && !categoryId) unknownCategoryReferences += 1;
      const article: CentralMasterArticle = {
        articleNumber: a.articleNumber,
        officialArticleNumber: a.officialArticleNumber,
        idType: a.idType,
        description: a.description,
        unit: a.unit,
        supplier: a.supplier,
        costPrice: a.costPrice,
        categoryId,
        sourceProductGroup: a.productGroup,
        countPeriod: a.countPeriod,
        rawCountPeriod: a.rawCountPeriod,
        status: a.status,
        rawStatus: a.rawStatus,
        assortmentActive: a.assortmentActive ?? true,
      };
      if (a.stockClassification !== undefined) article.stockClassification = a.stockClassification;
      return article;
    })
    .sort((a, b) => compare(a.articleNumber, b.articleNumber));

  const locations: CentralMasterLocation[] = [...office.locations]
    .sort((a, b) => a.number - b.number)
    .map((l) => ({ id: l.id, number: l.number, name: l.name, active: l.active }));
  const locationIds = new Set(locations.map((l) => l.id));
  const articleNumberById = new Map(included.map((a) => [a.id, a.articleNumber]));

  const assignments: CentralMasterAssignment[] = assignmentsRaw
    .filter((a) => articleNumberById.has(a.articleId) && locationIds.has(a.locationId))
    .map((a) => ({ articleNumber: articleNumberById.get(a.articleId)!, locationId: a.locationId, active: a.active }))
    .sort((a, b) => compare(a.articleNumber, b.articleNumber) || compare(a.locationId, b.locationId));

  const content = {
    schemaVersion: CENTRAL_MASTER_SCHEMA_VERSION,
    officeId: office.id,
    office: { name: office.name, baseDate: office.baseDate },
    locations,
    categories,
    articles,
    assignments,
    deletedArticleNumbers: [] as string[],
  } as const;
  const revision = computeMasterRevision(content);
  const file: CentralMasterFile = { ...content, generatedAt: input.generatedAt, revision };

  // Zelfde validatie als de app: wat hier niet door de parser komt, wordt nooit gepubliceerd.
  const validated = parseCentralMasterFile(JSON.parse(JSON.stringify(file)), office.id);

  return {
    file: validated,
    stats: {
      officeId: office.id,
      articles: articles.length,
      locations: locations.length,
      assignments: assignments.length,
      categories: categories.length,
      temporaryExcluded,
      unknownCategoryReferences,
      categoriesAlignedWithOtherOffices: aligned,
    },
  };
}

/**
 * Deterministische serialisatie: kopvelden leesbaar, daarna één regel per
 * element van de lange lijsten — kleine, leesbare git-diffs.
 */
export function serializeCentralMasterFile(file: CentralMasterFile): string {
  const lines = <T>(items: T[]): string =>
    items.length === 0 ? "[]" : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  return (
    "{\n" +
    `  "schemaVersion": ${file.schemaVersion},\n` +
    `  "officeId": ${JSON.stringify(file.officeId)},\n` +
    `  "generatedAt": ${JSON.stringify(file.generatedAt)},\n` +
    `  "revision": ${JSON.stringify(file.revision)},\n` +
    `  "office": ${JSON.stringify(file.office)},\n` +
    `  "locations": ${lines(file.locations)},\n` +
    `  "categories": ${lines(file.categories)},\n` +
    `  "articles": ${lines(file.articles)},\n` +
    `  "assignments": ${lines(file.assignments)},\n` +
    `  "deletedArticleNumbers": ${JSON.stringify(file.deletedArticleNumbers)}\n` +
    "}\n"
  );
}
