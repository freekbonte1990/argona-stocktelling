import { getStockClassification } from "./stockClassification";
import { isArticleActiveInAssortment } from "./articleAssortment";
import {
  isCentrallyManaged,
  isTemporaryArticle,
  type CentralMasterApplyPlan,
  type CentralMasterApplySummary,
  type CentralMasterArticle,
  type CentralMasterFile,
  type CentralMasterStatus,
} from "./centralMasterFile";
import type { Article, ArticleLocationAssignment, Location, Office, ProductCategory } from "./types";

/**
 * PURE toepassing van een centrale master op de lokale stamdata: berekent WAT er
 * geschreven moet worden, schrijft zelf niets (dat doet
 * `CountingRepository#applyCentralMaster` in één transactie).
 *
 * Eigenaarschap (user-eisen):
 *  - De centrale master is autoritatief voor ACTUELE masterdata: kantoornaam,
 *    locaties, productgamma's, artikelstamvelden, assortiment, telfrequentie.
 *  - De historiek is autoritatief voor TELLINGEN. Dit plan raakt daarom NOOIT:
 *    sessies, CountEntries, locatiestatussen, bevroren resultaten
 *    (FinalizedSessionResult), historische sheets, HISTORIE-regels, `previousCount`
 *    of `comment`. (Een test bewaakt dat al die tabellen byte-gelijk blijven.)
 *  - Lokaal aangemaakte TMP-artikelen worden nooit overschreven, gedeactiveerd of
 *    verwijderd. Een artikel verdwijnt NOOIT: wat uit de master verdwijnt, wordt
 *    enkel inactief in het assortiment (afwezig ≠ verwijderd).
 */

export interface CentralMasterLocalState {
  /** Het lokale kantoor, of `undefined` op een gloednieuw toestel (bootstrap). */
  office: Office | undefined;
  /** Artikelen van DIT kantoor. */
  articles: Article[];
  /** Artikelen van ALLE kantoren (nodig om lokaal-willekeurige categorie-id's te herleiden). */
  allArticles: Article[];
  /** Koppelingen van DIT kantoor. */
  assignments: ArticleLocationAssignment[];
  /** De globale lijst productgamma's. */
  categories: ProductCategory[];
}

export interface PlanCentralMasterInput {
  master: CentralMasterFile;
  local: CentralMasterLocalState;
  previousStatus: CentralMasterStatus | undefined;
  now: string;
  selectOffice?: boolean;
}

const HISTORICAL_ONLY_ID_TYPES = new Set(["LEGACY", "CENTRALE HISTORIEK"]);

function isHistoricalOnly(article: Article): boolean {
  return article.idType !== null && HISTORICAL_ONLY_ID_TYPES.has(article.idType);
}

function unionOf(...lists: Array<readonly string[] | undefined>): string[] {
  const out = new Set<string>();
  for (const list of lists) for (const item of list ?? []) out.add(item);
  return Array.from(out);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** De door de master beheerde velden van een artikel, in één opgebouwd (gedeeltelijk) `Article`. */
function masterOwnedFields(master: CentralMasterArticle): Partial<Article> {
  const fields: Partial<Article> = {
    officialArticleNumber: master.officialArticleNumber,
    idType: master.idType,
    description: master.description,
    productGroup: master.sourceProductGroup,
    supplier: master.supplier,
    unit: master.unit,
    costPrice: master.costPrice,
    rawCountPeriod: master.rawCountPeriod,
    countPeriod: master.countPeriod,
    rawStatus: master.rawStatus,
    status: master.status,
    categoryId: master.categoryId,
    assortmentActive: master.assortmentActive,
  };
  // `stockClassification` is LOKAAL beheerde businessdata: niet hier, dus nooit
  // overschreven bij een bestaand artikel. De masterwaarde is enkel een initiële
  // waarde (nieuw artikel) of een eenmalige OBSOLETE-backfill (zie hieronder).
  return fields;
}

function differs(existing: Article, fields: Partial<Article>): boolean {
  for (const key of Object.keys(fields) as Array<keyof Article>) {
    const next = fields[key] ?? null;
    let current: unknown = existing[key] ?? null;
    if (key === "assortmentActive") current = isArticleActiveInAssortment(existing);
    if (current !== next) return true;
  }
  return false;
}

export function planCentralMasterApply(input: PlanCentralMasterInput): CentralMasterApplyPlan {
  const { master, local, previousStatus, now } = input;
  const officeId = master.officeId;
  const adoption = !isCentrallyManaged(previousStatus);
  const summary: CentralMasterApplySummary = {
    articlesAdded: 0,
    articlesUpdated: 0,
    articlesUnchanged: 0,
    articlesDeactivated: 0,
    localArticlesKept: 0,
    locationsAdded: 0,
    locationsUpdated: 0,
    locationsDeactivated: 0,
    assignmentsWritten: 0,
    categoriesWritten: 0,
    categoriesRemapped: 0,
  };

  // ---------------------------------------------------------------- categorieën
  const masterCategoryIds = new Set(master.categories.map((c) => c.id));
  const masterCategoryByName = new Map(master.categories.map((c) => [normalizeName(c.name), c]));
  const localCategoryById = new Map(local.categories.map((c) => [c.id, c]));

  // Een lokaal (willekeurig gegenereerd) productgamma met dezelfde NAAM als een
  // centraal productgamma maar een ander id wordt samengevoegd: artikelen
  // verwijzen voortaan naar het centrale id, het lokale dubbele gamma verdwijnt.
  const categoryRemap = new Map<string, string>();
  for (const localCategory of local.categories) {
    if (masterCategoryIds.has(localCategory.id)) continue;
    const target = masterCategoryByName.get(normalizeName(localCategory.name));
    if (target) categoryRemap.set(localCategory.id, target.id);
  }
  summary.categoriesRemapped = categoryRemap.size;
  const categoryIdsToDelete = Array.from(categoryRemap.keys());

  const categoriesToWrite = master.categories.filter((c) => {
    const current = localCategoryById.get(c.id);
    return !current || current.name !== c.name || current.sortOrder !== c.sortOrder || current.active !== c.active;
  });
  summary.categoriesWritten = categoriesToWrite.length;

  const remapCategoryId = (id: string | null | undefined): string | null | undefined =>
    id !== null && id !== undefined && categoryRemap.has(id) ? categoryRemap.get(id)! : id;

  const remappedIds = new Set<string>();
  const workingByOffice = new Map<string, Article>();
  for (const article of local.articles) {
    const remapped = remapCategoryId(article.categoryId);
    if (remapped !== article.categoryId) {
      remappedIds.add(article.id);
      workingByOffice.set(article.id, { ...article, categoryId: remapped as string | null });
    } else {
      workingByOffice.set(article.id, article);
    }
  }
  const otherOfficeArticles: Article[] = [];
  const officeArticleIds = new Set(local.articles.map((a) => a.id));
  for (const article of local.allArticles) {
    if (officeArticleIds.has(article.id) || article.officeId === officeId) continue;
    const remapped = remapCategoryId(article.categoryId);
    if (remapped !== article.categoryId) {
      otherOfficeArticles.push({ ...article, categoryId: remapped as string | null });
    }
  }

  // ------------------------------------------------------------------ locaties
  const masterLocationIds = new Set(master.locations.map((l) => l.id));
  const localLocations = local.office?.locations ?? [];
  const localLocationById = new Map(localLocations.map((l) => [l.id, l]));
  const locations: Location[] = master.locations.map((l) => ({
    id: l.id,
    officeId,
    number: l.number,
    name: l.name,
    active: l.active,
  }));
  for (const location of locations) {
    const current = localLocationById.get(location.id);
    if (!current) summary.locationsAdded += 1;
    else if (current.name !== location.name || current.number !== location.number || current.active !== location.active) {
      summary.locationsUpdated += 1;
    }
  }
  const maxMasterNumber = Math.max(0, ...master.locations.map((l) => l.number));
  let cursor = maxMasterNumber;
  const localOnly = localLocations.filter((l) => !masterLocationIds.has(l.id)).sort((a, b) => a.number - b.number);
  for (const location of localOnly) {
    const wasCentral = previousStatus?.locationIds.includes(location.id) ?? false;
    let next: Location = location;
    if (wasCentral) {
      // Verdwenen uit de master: nooit verwijderen (CountEntries/koppelingen verwijzen ernaar), wel inactief.
      if (location.active) summary.locationsDeactivated += 1;
      next = { ...location, active: false };
    }
    if (next.number <= cursor) next = { ...next, number: ++cursor };
    else cursor = next.number;
    locations.push(next);
  }

  const office: Office = {
    ...(local.office ?? {}),
    id: officeId,
    name: master.office.name,
    baseDate: master.office.baseDate,
    locations,
    // De eenmalige productgroep-migratie mag voor een centraal beheerd kantoor NOOIT draaien.
    categoriesMigrated: true,
  };

  // ------------------------------------------------------------------ artikelen
  const articles: Article[] = [];
  const masterArticleIds = new Set<string>();
  const handled = new Set<string>();
  for (const m of master.articles) {
    const id = `${officeId}:${m.articleNumber}`;
    masterArticleIds.add(id);
    handled.add(id);
    const existing = workingByOffice.get(id);
    // Tijdelijke (TMP) artikels zijn lokaal bewerkbaar: bij een bestaand artikel
    // wint de lokale waarde altijd, de sync overschrijft er niets van.
    const fields = existing && isTemporaryArticle(existing) ? {} : masterOwnedFields(m);
    // Eenmalige bronbackfill (enkel omhoog): de master zegt expliciet OBSOLETE en
    // de classificatie is lokaal nog nooit handmatig aangepast. Een handmatige
    // keuze (`stockClassificationManual`) is altijd leidend; nooit een downgrade.
    if (
      existing &&
      !isTemporaryArticle(existing) &&
      m.stockClassification === "OBSOLETE" &&
      !existing.stockClassificationManual &&
      getStockClassification(existing) !== "OBSOLETE"
    ) {
      fields.stockClassification = "OBSOLETE";
    }
    if (!existing) {
      summary.articlesAdded += 1;
      articles.push({
        id,
        officeId,
        articleNumber: m.articleNumber,
        officialArticleNumber: m.officialArticleNumber,
        idType: m.idType,
        description: m.description,
        productGroup: m.sourceProductGroup,
        supplier: m.supplier,
        unit: m.unit,
        costPrice: m.costPrice,
        rawCountPeriod: m.rawCountPeriod,
        countPeriod: m.countPeriod,
        rawStatus: m.rawStatus,
        status: m.status,
        // `previousCount` komt NOOIT uit de master (historiek is autoritatief voor tellingen).
        previousCount: null,
        sourceRow: null,
        categoryId: m.categoryId,
        assortmentActive: m.assortmentActive,
        ...(m.stockClassification !== undefined ? { stockClassification: m.stockClassification } : {}),
      });
    } else if (differs(existing, fields) || remappedIds.has(id)) {
      if (differs(existing, fields)) summary.articlesUpdated += 1;
      else summary.articlesUnchanged += 1;
      articles.push({ ...existing, ...fields } as Article);
    } else {
      summary.articlesUnchanged += 1;
    }
  }

  for (const article of local.articles) {
    if (handled.has(article.id)) continue;
    const working = workingByOffice.get(article.id)!;
    if (isTemporaryArticle(article)) {
      summary.localArticlesKept += 1;
      if (remappedIds.has(article.id)) articles.push(working);
      continue;
    }
    const wasCentral = previousStatus?.articleIds.includes(article.id) ?? false;
    const deactivate =
      isArticleActiveInAssortment(working) && (wasCentral || (adoption && !isHistoricalOnly(article)));
    if (deactivate) {
      summary.articlesDeactivated += 1;
      articles.push({ ...working, assortmentActive: false });
    } else {
      summary.localArticlesKept += 1;
      if (remappedIds.has(article.id)) articles.push(working);
    }
  }

  // ---------------------------------------------------------------- koppelingen
  const localAssignmentById = new Map(local.assignments.map((a) => [a.id, a]));
  const assignments: ArticleLocationAssignment[] = [];
  const masterAssignmentIds: string[] = [];
  const currentAssignmentIds = new Set<string>();
  for (const m of master.assignments) {
    const articleId = `${officeId}:${m.articleNumber}`;
    const id = `${officeId}:${articleId}:${m.locationId}`;
    currentAssignmentIds.add(id);
    masterAssignmentIds.push(id);
    const existing = localAssignmentById.get(id);
    if (!existing) {
      assignments.push({ id, officeId, articleId, locationId: m.locationId, active: m.active, lastSeenAt: master.generatedAt });
      continue;
    }
    // Nieuwste `lastSeenAt` wint (zelfde regel als de Excel-import): een lokale wijziging van ná de
    // publicatie blijft staan tot een nieuwere publicatie ze overneemt.
    if (existing.lastSeenAt > master.generatedAt) continue;
    if (existing.active !== m.active || existing.lastSeenAt !== master.generatedAt) {
      assignments.push({ ...existing, active: m.active, lastSeenAt: master.generatedAt });
    }
  }
  for (const previousId of previousStatus?.assignmentIds ?? []) {
    if (currentAssignmentIds.has(previousId)) continue;
    const existing = localAssignmentById.get(previousId);
    if (!existing || !existing.active) continue;
    // Enkel als het artikel zelf nog centraal bestaat: de master zegt dan expliciet "niet meer hier".
    if (!masterArticleIds.has(existing.articleId)) continue;
    if (existing.lastSeenAt > master.generatedAt) continue;
    assignments.push({ ...existing, active: false, lastSeenAt: master.generatedAt });
  }
  summary.assignmentsWritten = assignments.length;

  const status: CentralMasterStatus = {
    officeId,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastError: null,
    revision: master.revision,
    generatedAt: master.generatedAt,
    appliedAt: now,
    pendingRevision: null,
    articleIds: unionOf(previousStatus?.articleIds, Array.from(masterArticleIds)),
    locationIds: unionOf(previousStatus?.locationIds, master.locations.map((l) => l.id)),
    categoryIds: unionOf(previousStatus?.categoryIds, master.categories.map((c) => c.id)),
    assignmentIds: unionOf(previousStatus?.assignmentIds, masterAssignmentIds),
  };

  return {
    office,
    articles,
    assignments,
    categories: categoriesToWrite,
    categoryIdsToDelete,
    otherOfficeArticles,
    importMeta: { officeId, sourceFileName: `Centrale master (${master.revision})`, importedAt: now },
    status,
    selectOffice: input.selectOffice ?? false,
    summary,
  };
}
