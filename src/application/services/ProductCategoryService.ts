import { isCentrallyManaged } from "../../domain/centralMasterFile";
import {
  activeProductCategoriesInOrder,
  addProductCategory,
  allProductCategoriesInOrder,
  assignArticlesToCategory,
  buildCategoryResolutionByArticleId,
  canHardDeleteProductCategory,
  mergeProductCategory,
  migrateProductGroupsToCategories,
  removeUnusedProductCategory,
  renameProductCategory,
  reorderProductCategories,
  setProductCategoryActive,
} from "../../domain/productCategory";
import type { ArticleCategoryResolution } from "../../domain/productCategory";
import type { Article, ProductCategory } from "../../domain/types";
import { generateProductCategoryId } from "../../shared/ids";
import type { CountingRepository } from "../ports/CountingRepository";

/**
 * Orkestreert de "Productgamma"-laag (Sprint 3.2): CRUD, veilige migratie
 * (bootstrap uit bestaande `productGroup`-waarden), samenvoegen/verwijderen,
 * en artikeltoewijzing (individueel of bulk — beide dezelfde onderliggende
 * pure functie). Geen enkele UI-pagina schrijft rechtstreeks naar de
 * `productCategories`-tabel: alles loopt via deze service, die op zijn beurt
 * enkel pure `domain/productCategory.ts`-functies aanroept en het resultaat
 * bewaart via `CountingRepository`.
 */
export class ProductCategoryService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  /**
   * Eenmalige, veilige migratie (spec §4), PER KANTOOR gegate (Sprint
   * 3.2.1-architectuurfix): bootstrapt categorieën uit de bestaande
   * `Article.productGroup`-waarden van DIT kantoor en wijst elk artikel toe
   * aan zijn eigen bronwaarde — nooit een individuele herclassificatie.
   *
   * `ProductCategory` is nu bedrijfsbreed/globaal (geen `officeId` meer), dus
   * de oude gate ("heeft dit kantoor al minstens één categorie?") werkt niet
   * meer: zodra ÉÉN kantoor gemigreerd heeft, is de globale lijst voor ELK
   * ander kantoor ook al niet-leeg, waardoor die andere kantoren hun eigen
   * migratie stilzwijgend zouden overslaan. Vandaar een expliciete,
   * PER-KANTOOR vlag (`Office.categoriesMigrated`) — onafhankelijk van hoeveel
   * categorieën er globaal al bestaan.
   *
   * `migrateProductGroupsToCategories` zelf blijft simpelweg matchen tegen "welke
   * categorieën bestaan al" (nu de globale lijst): migreert kantoor A eerst
   * (creëert "Kabels"), dan hergebruikt kantoor B's latere migratie diezelfde
   * globale "Kabels"-ID in plaats van een tweede aan te maken — dat is precies
   * het mechanisme dat drie aparte "Kabels"-records met verschillende ID's
   * voorkomt.
   *
   * Idempotent per kantoor: eenmaal `categoriesMigrated: true`, wordt dit
   * nooit meer herhaald voor dat kantoor, zodat latere, bewuste beheeracties
   * (samenvoegen/hernoemen/deactiveren) nooit ongedaan gemaakt worden.
   */
  private async ensureMigrated(officeId: string): Promise<void> {
    const office = await this.repository.getOffice(officeId);
    if (office?.categoriesMigrated) return;
    // Centraal beheerd kantoor: de productgamma's komen uit de centrale master. De
    // eenmalige productgroep-migratie (lokaal willekeurige categorie-id's uit
    // `Article.productGroup`) mag hier NOOIT draaien — ook niet als de vlag door een
    // Excel-import (die `categoriesMigrated` niet kent) zou ontbreken.
    if (isCentrallyManaged(await this.repository.getCentralMasterStatus(officeId))) return;

    const existing = await this.repository.getProductCategories();
    const articles = await this.repository.getArticles(officeId);
    const migrated = migrateProductGroupsToCategories(existing, articles, () => generateProductCategoryId());

    if (migrated.categories.length !== existing.length) {
      await this.repository.saveProductCategories(migrated.categories);
    }
    const changedArticles = migrated.articles.filter((article, index) => article !== articles[index]);
    if (changedArticles.length > 0) {
      await this.repository.saveArticles(changedArticles);
    }

    if (office) {
      await this.repository.saveOffice({ ...office, categoriesMigrated: true });
    }
  }

  /**
   * Alle categorieën, migreert eerst indien nodig voor DIT kantoor — de enige
   * "leeslijn" die elk UI-scherm gebruikt. `officeId` stuurt enkel de
   * per-kantoor migratiebootstrap (`ensureMigrated`) aan; de teruggegeven
   * lijst zelf is altijd de volledige, globale (bedrijfsbrede) lijst — zie
   * `ProductCategory` in domain/types.ts.
   */
  async listCategories(officeId: string): Promise<ProductCategory[]> {
    await this.ensureMigrated(officeId);
    return allProductCategoriesInOrder(await this.repository.getProductCategories());
  }

  async listActiveCategories(officeId: string): Promise<ProductCategory[]> {
    return activeProductCategoriesInOrder(await this.listCategories(officeId));
  }

  /**
   * Bouwt de expliciete `articleId -> huidige Productgamma`-resolutiemap
   * (spec §12) voor `AnalysisService`/`ComparisonService` — leest de HUIDIGE
   * artikelstam, nooit een bevroren snapshot.
   *
   * BELANGRIJK: `listCategories` hieronder kan, bij de EERSTE aanroep voor
   * een kantoor, de eenmalige migratie (spec §4) triggeren — die schrijft
   * meteen ook `Article.categoryId` weg via `saveArticles`. Deze twee
   * aanroepen mogen daarom NOOIT via `Promise.all` parallel lopen: dat gaf
   * hier eerder een race condition waarbij `getArticles` de artikelen las
   * VÓÓR de migratie haar `saveArticles`-schrijfactie had voltooid, met een
   * resolutiemap zonder de zonet aangemaakte `categoryId` tot gevolg. Vandaar
   * bewust sequentieel: eerst categorieën (incl. migratie) volledig
   * afhandelen, pas daarna de (mogelijk zopas bijgewerkte) artikelen lezen.
   */
  async buildCategoryResolution(officeId: string): Promise<Map<string, ArticleCategoryResolution>> {
    const categories = await this.listCategories(officeId);
    const articles = await this.repository.getArticles(officeId);
    return buildCategoryResolutionByArticleId(articles, categories);
  }

  /**
   * `officeId` stuurt enkel `listCategories`s per-kantoor migratiebootstrap
   * aan — de nieuwe categorie zelf is meteen globaal/bedrijfsbreed
   * beschikbaar voor elk ander kantoor (spec: geen drie aparte "Kabels" meer).
   */
  async addCategory(officeId: string, name: string): Promise<ProductCategory[]> {
    const categories = await this.listCategories(officeId);
    const next = addProductCategory(categories, name, generateProductCategoryId());
    await this.repository.saveProductCategories(next);
    return next;
  }

  async renameCategory(officeId: string, categoryId: string, newName: string): Promise<ProductCategory[]> {
    const categories = await this.listCategories(officeId);
    const next = renameProductCategory(categories, categoryId, newName);
    await this.repository.saveProductCategories(next);
    return next;
  }

  async reorderCategories(officeId: string, orderedIds: string[]): Promise<ProductCategory[]> {
    const categories = await this.listCategories(officeId);
    const next = reorderProductCategories(categories, orderedIds);
    await this.repository.saveProductCategories(next);
    return next;
  }

  async setCategoryActive(officeId: string, categoryId: string, active: boolean): Promise<ProductCategory[]> {
    const categories = await this.listCategories(officeId);
    const next = setProductCategoryActive(categories, categoryId, active);
    await this.repository.saveProductCategories(next);
    return next;
  }

  /**
   * Enkel mogelijk voor een categorie die nog aan geen enkel artikel
   * toegewezen is (spec §6) — anders: `mergeCategory` of
   * `setCategoryActive(..., false)`.
   *
   * Sprint 3.2.1-architectuurfix: een categorie is nu bedrijfsbreed/globaal,
   * dus "nog aan geen enkel artikel toegewezen" moet over ALLE kantoren heen
   * gecontroleerd worden (`getAllArticles`), niet enkel binnen het huidige
   * kantoor — anders zou een categorie die alleen bij een ANDER kantoor in
   * gebruik is hier ten onrechte verwijderbaar lijken.
   */
  async deleteUnusedCategory(officeId: string, categoryId: string): Promise<ProductCategory[]> {
    // Sequentieel, niet via Promise.all (zie de uitgebreide toelichting bij
    // `buildCategoryResolution`): `listCategories` kan hier de eenmalige
    // migratie triggeren, die zelf `Article.categoryId` wegschrijft — de
    // daaropvolgende `getAllArticles` moet die schrijfactie altijd zien.
    const categories = await this.listCategories(officeId);
    const articles = await this.repository.getAllArticles();
    const next = removeUnusedProductCategory(categories, categoryId, articles);
    await this.repository.deleteProductCategory(categoryId);
    await this.repository.saveProductCategories(next);
    return next;
  }

  canDeleteCategory(articles: Article[], categoryId: string): boolean {
    return canHardDeleteProductCategory(categoryId, articles);
  }

  /**
   * Voegt `sourceId` samen in `targetId` (spec §6): verplaatst alle
   * toewijzingen en maakt de bron inactief (nooit hard verwijderd, voor
   * auditeerbaarheid). Geeft `movedArticleCount` terug zodat de UI dat kan
   * tonen in de bevestigingsdialoog.
   *
   * Sprint 3.2.1-architectuurfix: verplaatst toewijzingen over ALLE kantoren
   * heen (`getAllArticles`) — een globale categorie kan immers door eender
   * welk kantoor gebruikt zijn, niet enkel het kantoor van waaruit de
   * samenvoeging gestart werd.
   */
  async mergeCategories(
    officeId: string,
    sourceId: string,
    targetId: string,
  ): Promise<{ categories: ProductCategory[]; movedArticleCount: number }> {
    // Sequentieel — zelfde race-condition-reden als hierboven (`deleteUnusedCategory`/`buildCategoryResolution`).
    const categories = await this.listCategories(officeId);
    const articles = await this.repository.getAllArticles();
    const result = mergeProductCategory(categories, articles, sourceId, targetId);
    await this.repository.saveProductCategories(result.categories);
    await this.repository.saveArticles(result.articles);
    return { categories: result.categories, movedArticleCount: result.movedArticleCount };
  }

  /**
   * Wijst één (§7) of meerdere (§8, bulk) artikelen toe aan een categorie —
   * `categoryId: null` betekent "niet ingedeeld". Wijzigt UITSLUITEND
   * `Article.categoryId`; de bevroren `Article.productGroup` (bronproduct-
   * groep) en alle reeds afgeronde sessiesnapshots blijven volledig
   * onaangeroerd (spec §7/§8/§13).
   */
  async assignArticles(officeId: string, articleIds: string[], categoryId: string | null): Promise<void> {
    if (articleIds.length === 0) return;
    const articles = await this.repository.getArticles(officeId);
    const next = assignArticlesToCategory(articles, articleIds, categoryId);
    const idSet = new Set(articleIds);
    await this.repository.saveArticles(next.filter((a) => idSet.has(a.id)));
  }
}
