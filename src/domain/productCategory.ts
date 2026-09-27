import type { Article, ProductCategory } from "./types";

/**
 * Sprint 3.2 — Dynamic Product Categories & Retroactive Classification.
 *
 * KERNREGEL (spec, letterlijk): "Historische feiten blijven bevroren, maar
 * de management-classificatie mag met terugwerkende kracht wijzigen." Dit
 * bestand bevat de PURE domeinlogica voor de "Productgamma"-laag —
 * `ProductCategory` is een standalone entiteit (stabiele `id`, zoals
 * `Location`), en `Article.categoryId` verwijst naar die `id`, nooit naar een
 * naam (een categorie kan hernoemd worden zonder dat toewijzingen breken).
 *
 * Bewust volledig gescheiden van `Article.productGroup` (de historische/
 * bron-productgroep, zie types.ts): dat veld wordt door dit bestand nooit
 * gelezen of geschreven. Enkel de migratiefunctie hieronder leest het
 * eenmalig, uitsluitend om de EERSTE generatie categorieën te bootstrappen.
 *
 * Puur domein: geen IndexedDB, geen React, geen Excel. UI/services roepen
 * deze functies aan en bewaren het resultaat via `CountingRepository`.
 */

/** Weergavelabel voor een artikel zonder (of met een onbekende/verwijderde) canonieke categorie — spec §9: "mag niet verborgen worden". */
export const PRODUCT_CATEGORY_FALLBACK = "Niet ingedeeld";

// ---------------------------------------------------------------------------
// CRUD (spec §3/§5) — zelfde stijl als domain/locations.ts
// ---------------------------------------------------------------------------

function nextSortOrder(categories: ProductCategory[]): number {
  return categories.length === 0 ? 1 : Math.max(...categories.map((c) => c.sortOrder)) + 1;
}

/** Namen zijn uniek, ongeacht hoofdletters (spec §3) — vergelijkt tegen ALLE categorieën (actief + inactief). */
export function isCategoryNameTaken(
  categories: ProductCategory[],
  name: string,
  excludeId: string | null = null,
): boolean {
  const normalized = name.trim().toLowerCase();
  return categories.some((c) => c.id !== excludeId && c.name.trim().toLowerCase() === normalized);
}

export class DuplicateCategoryNameError extends Error {
  constructor(name: string) {
    super(`Er bestaat al een productgamma met de naam "${name.trim()}".`);
    this.name = "DuplicateCategoryNameError";
  }
}

export function addProductCategory(
  categories: ProductCategory[],
  name: string,
  id: string,
): ProductCategory[] {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Naam van het productgamma mag niet leeg zijn.");
  }
  if (isCategoryNameTaken(categories, trimmed)) {
    throw new DuplicateCategoryNameError(trimmed);
  }
  const category: ProductCategory = {
    id,
    name: trimmed,
    sortOrder: nextSortOrder(categories),
    active: true,
  };
  return [...categories, category];
}

export function renameProductCategory(
  categories: ProductCategory[],
  categoryId: string,
  newName: string,
): ProductCategory[] {
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new Error("Naam van het productgamma mag niet leeg zijn.");
  }
  if (isCategoryNameTaken(categories, trimmed, categoryId)) {
    throw new DuplicateCategoryNameError(trimmed);
  }
  return categories.map((c) => (c.id === categoryId ? { ...c, name: trimmed } : c));
}

/**
 * Past de weergavevolgorde aan — `orderedIds` moet exact een permutatie zijn
 * van de bestaande categorie-ID's, anders wordt er niets gewijzigd (zelfde
 * defensieve gedrag als `domain/locations.ts#reorderLocations`).
 */
export function reorderProductCategories(
  categories: ProductCategory[],
  orderedIds: string[],
): ProductCategory[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  if (orderedIds.length !== categories.length) return categories;
  if (!orderedIds.every((id) => byId.has(id))) return categories;
  if (new Set(orderedIds).size !== orderedIds.length) return categories;
  return orderedIds.map((id, index) => ({ ...byId.get(id)!, sortOrder: index + 1 }));
}

export function setProductCategoryActive(
  categories: ProductCategory[],
  categoryId: string,
  active: boolean,
): ProductCategory[] {
  return categories.map((c) => (c.id === categoryId ? { ...c, active } : c));
}

export function activeProductCategoriesInOrder(categories: ProductCategory[]): ProductCategory[] {
  return [...categories].filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function allProductCategoriesInOrder(categories: ProductCategory[]): ProductCategory[] {
  return [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Aantal artikelen dat momenteel aan deze categorie toegewezen is (spec §5: "aantal toegewezen artikelen tonen"). */
export function countArticlesInCategory(articles: Article[], categoryId: string): number {
  return articles.filter((a) => (a.categoryId ?? null) === categoryId).length;
}

// ---------------------------------------------------------------------------
// Veilig verwijderen / samenvoegen (spec §6)
// ---------------------------------------------------------------------------

export function canHardDeleteProductCategory(categoryId: string, articles: Article[]): boolean {
  return !articles.some((a) => (a.categoryId ?? null) === categoryId);
}

/**
 * Verwijdert een NOOIT-gebruikte categorie hard uit de lijst. Gooit een fout
 * wanneer ze toch al aan minstens één artikel toegewezen is — de UI moet dan
 * `mergeProductCategory` (samenvoegen) of `setProductCategoryActive(...,
 * false)` (inactief maken) aanbieden in plaats van deze functie aan te
 * roepen (spec §6: "mag NIET simpelweg verwijderd worden").
 */
export function removeUnusedProductCategory(
  categories: ProductCategory[],
  categoryId: string,
  articles: Article[],
): ProductCategory[] {
  const category = categories.find((c) => c.id === categoryId);
  if (!category) return categories;
  if (!canHardDeleteProductCategory(categoryId, articles)) {
    throw new Error(
      `Productgamma "${category.name}" is al aan artikelen toegewezen en kan niet verwijderd worden — voeg het samen met een ander productgamma of maak het inactief.`,
    );
  }
  return categories.filter((c) => c.id !== categoryId);
}

export interface MergeProductCategoryResult {
  categories: ProductCategory[];
  articles: Article[];
  /** Aantal artikelen dat effectief van `sourceId` naar `targetId` verhuisde (voor de bevestigingsdialoog, spec §6). */
  movedArticleCount: number;
}

/**
 * Voegt `sourceId` samen in `targetId` (spec §6, voorbeeld: "Connectivity →
 * Smart meters"): verplaatst ALLE canonieke toewijzingen naar de doelgroep,
 * en maakt de brongroep vervolgens INACTIEF in plaats van ze te vernietigen
 * (spec: "behoudt liever de auditeerbaarheid" — historische bronproductgroep/
 * hoeveelheden/kostprijzen/snapshots blijven hierdoor sowieso volledig
 * onaangeroerd, want die staan nooit in `ProductCategory` of `categoryId`
 * van een bevroren snapshot, enkel op het LEVENDE `Article`).
 */
export function mergeProductCategory(
  categories: ProductCategory[],
  articles: Article[],
  sourceId: string,
  targetId: string,
): MergeProductCategoryResult {
  if (sourceId === targetId) {
    throw new Error("Kan een productgamma niet met zichzelf samenvoegen.");
  }
  const source = categories.find((c) => c.id === sourceId);
  const target = categories.find((c) => c.id === targetId);
  if (!source || !target) {
    throw new Error("Onbekend productgamma.");
  }
  let movedArticleCount = 0;
  const nextArticles = articles.map((a) => {
    if ((a.categoryId ?? null) === sourceId) {
      movedArticleCount += 1;
      return { ...a, categoryId: targetId };
    }
    return a;
  });
  const nextCategories = categories.map((c) => (c.id === sourceId ? { ...c, active: false } : c));
  return { categories: nextCategories, articles: nextArticles, movedArticleCount };
}

/** Wijst één of meerdere artikelen toe aan een categorie (individuele wijziging §7, of bulk §8 — beide dezelfde pure functie). */
export function assignArticlesToCategory(
  articles: Article[],
  articleIds: string[],
  categoryId: string | null,
): Article[] {
  const idSet = new Set(articleIds);
  return articles.map((a) => (idSet.has(a.id) ? { ...a, categoryId } : a));
}

// ---------------------------------------------------------------------------
// Resolutie voor weergave/analyse (spec §9/§11/§12)
// ---------------------------------------------------------------------------

/**
 * Weergavenaam van een categorie-ID — `null`/onbekend/verwijderd geeft
 * bewust `PRODUCT_CATEGORY_FALLBACK` terug, nooit een lege string (spec §9:
 * "niet verbergen"). Inactieve categorieën resolven hier gewoon normaal naar
 * hun naam (spec §5: "blijven zichtbaar in historische analyse zolang nog
 * gebruikt") — enkel bij NIEUWE toewijzingscontrols wordt op `active`
 * gefilterd (zie `activeProductCategoriesInOrder`).
 */
export function resolveCategoryLabel(
  categoryId: string | null | undefined,
  categoriesById: Map<string, ProductCategory>,
): string {
  if (!categoryId) return PRODUCT_CATEGORY_FALLBACK;
  return categoriesById.get(categoryId)?.name ?? PRODUCT_CATEGORY_FALLBACK;
}

export function categoriesById(categories: ProductCategory[]): Map<string, ProductCategory> {
  return new Map(categories.map((c) => [c.id, c]));
}

/**
 * Bouwt, voor een gegeven artikelenlijst (de HUIDIGE, levende artikelstam),
 * een `articleId -> { categoryId, categoryName }`-resolutiemap — exact het
 * expliciete input-object dat spec §12 vraagt om aan de PURE
 * analyse-/vergelijkingsfuncties door te geven, in plaats van dat die zelf
 * live `Article`-data zouden lezen. Wordt opgeroepen door de
 * application-laag (`AnalysisService`/`ComparisonService`), NIET door
 * `domain/analysis.ts`/`domain/comparison.ts` zelf.
 */
export interface ArticleCategoryResolution {
  categoryId: string | null;
  categoryName: string;
}

export function buildCategoryResolutionByArticleId(
  articles: Article[],
  categories: ProductCategory[],
): Map<string, ArticleCategoryResolution> {
  const byId = categoriesById(categories);
  const result = new Map<string, ArticleCategoryResolution>();
  for (const article of articles) {
    const categoryId = article.categoryId ?? null;
    result.set(article.id, { categoryId, categoryName: resolveCategoryLabel(categoryId, byId) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Migratie (spec §4) — eenmalige bootstrap uit bestaande productGroup-waarden
// ---------------------------------------------------------------------------

export interface MigrateProductGroupsResult {
  categories: ProductCategory[];
  articles: Article[];
}

/**
 * Eenmalige, veilige migratie voor bestaande gebruikers (spec §4): bouwt
 * canonieke categorieën uit de reeds gebruikte `Article.productGroup`-
 * waarden, en wijst elk artikel toe aan de categorie die overeenkomt met
 * ZIJN EIGEN bronproductgroep. Verplaatst NOOIT stilzwijgend een artikel
 * naar een andere categorie dan zijn eigen bronwaarde (dat is voor latere,
 * expliciete beheeracties — spec: "verplaats geen individuele artikelen van
 * Laadpalen naar Kabels").
 *
 * Normalisatie (spec §4, letterlijk): "voor de hand liggende
 * hoofdletterverschillen veilig normaliseren waar dat deterministisch kan
 * (bv. LAADPALEN/Laadpalen/laadpaal kunnen naar één categorie herleid
 * worden) — gebruik GEEN product-naam-heuristieken." Dit is intern
 * tegenstrijdig: "laadpaal" (enkelvoud) vs. "Laadpalen" (meervoud) samen-
 * voegen is GEEN loutere hoofdletterkwestie, maar een taalkundige
 * heuristiek — precies wat expliciet verboden wordt. Om nooit stilzwijgend
 * artikelen verkeerd te groeperen, wordt hier BEWUST enkel getrimd +
 * case-insensitive geëxact-matched (bv. "LAADPALEN" en "Laadpalen" smelten
 * samen, "laadpaal" niet) — zie het eindrapport voor deze expliciete
 * architecturale keuze.
 *
 * Idempotent/additief: reeds bestaande categorieën (zelfde genormaliseerde
 * naam) worden hergebruikt, nooit gedupliceerd — veilig om opnieuw aan te
 * roepen. Een artikel dat al een `categoryId` heeft wordt nooit overschreven.
 * Een artikel zonder `productGroup` (`null`) blijft onaangeroerd/ongeclassificeerd.
 *
 * Sprint 3.2.1 (architectuurfix): `categories` is nu de GLOBALE lijst (over
 * ALLE kantoren heen, zie `ProductCategory`/`ProductCategoryService#
 * ensureMigrated`) — deze functie zelf blijft ONGEWIJZIGD puur/kantoor-
 * agnostisch, ze matcht simpelweg tegen "welke categorieën bestaan al"
 * ongeacht wie ze aanmaakte. Dat is precies wat dubbele "Kabels"-records
 * voorkomt: roept kantoor A deze functie eerst aan (creëert "Kabels"), dan
 * ziet kantoor B's latere aanroep die globale "Kabels" al in `categories` en
 * hergebruikt haar `id` in plaats van een tweede te maken — ook al heeft
 * kantoor B zelf nog nooit gemigreerd. Geen `officeId` meer nodig op de
 * aangemaakte categorie (zie `ProductCategory`).
 */
export function migrateProductGroupsToCategories(
  categories: ProductCategory[],
  articles: Article[],
  generateId: () => string,
): MigrateProductGroupsResult {
  const byNormalizedName = new Map<string, ProductCategory>();
  for (const category of categories) {
    byNormalizedName.set(category.name.trim().toLowerCase(), category);
  }

  let nextCategories = [...categories];
  const nextArticles = articles.map((article) => {
    if (article.categoryId !== undefined && article.categoryId !== null) {
      // Al ingedeeld (eerder gemigreerd of handmatig toegewezen) — nooit overschrijven.
      return article;
    }
    const raw = article.productGroup?.trim();
    if (!raw) return article; // Geen bronproductgroep -> blijft niet-ingedeeld.

    const normalized = raw.toLowerCase();
    let category = byNormalizedName.get(normalized);
    if (!category) {
      category = {
        id: generateId(),
        name: raw,
        sortOrder: nextSortOrder(nextCategories),
        active: true,
      };
      nextCategories = [...nextCategories, category];
      byNormalizedName.set(normalized, category);
    }
    return { ...article, categoryId: category.id };
  });

  return { categories: nextCategories, articles: nextArticles };
}
