import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ARTICLE_LIST_FILTERS,
  DEFAULT_ARTICLE_LIST_SORT_MODE,
  ARTICLE_LIST_SORT_MODE_LABELS,
  filterArticlesForList,
  sortArticlesForList,
  type ArticleCategoryFilterValue,
  type ArticleListSortMode,
} from "../../domain/articleListing";
import { activeLocationsInOrder } from "../../domain/locations";
import { activeProductCategoriesInOrder, allProductCategoriesInOrder, categoriesById } from "../../domain/productCategory";
import { articlesWithoutLocation } from "../../domain/withoutLocation";
import { productCategoryService } from "../../application/container";
import { ArticleBulkList } from "../components/ArticleBulkList";
import { useArticles, useAssignments, useOffice, useProductCategories, useSession } from "../hooks/useLiveData";

interface WithoutLocationPageProps {
  sessionId: string;
  onOpenArticle: (officeId: string, articleId: string) => void;
}

/**
 * "Zonder locatie" (v0.2.1 correctieronde §2): een DYNAMISCHE werklijst van
 * alle artikelen in de sessiescope zonder actieve `ArticleLocationAssignment`
 * — GEEN fysieke locatie, geen apart opslagpad. De berekening zelf staat in
 * `domain/withoutLocation.ts`; deze pagina toont het resultaat en hergebruikt
 * het gedeelde `ArticleBulkList` (dezelfde bulklocatiebediening + de
 * bestaande `LocationAssignmentService`) om vanhieruit snel een locatie te
 * kunnen toewijzen — zodra dat gebeurt, verdwijnt het artikel automatisch
 * uit deze lijst (de berekening wordt altijd opnieuw afgeleid uit de live
 * data, er is geen aparte status om bij te houden).
 *
 * Beschikbaar hier (spec): zoeken, sorteren (default Productgroep →
 * Omschrijving), en enkel een productgroepfilter — bewust geen
 * locatie/status/telfrequentie-filter, want die zijn hier niet relevant of
 * betekenisloos (elk artikel hier heeft per definitie "geen locatie").
 */
export function WithoutLocationPage({ sessionId, onOpenArticle }: WithoutLocationPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const officeArticles = useArticles(session?.officeId) ?? [];
  const assignments = useAssignments(session?.officeId) ?? [];

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ArticleCategoryFilterValue>("ALL");
  const [sortMode, setSortMode] = useState<ArticleListSortMode>(DEFAULT_ARTICLE_LIST_SORT_MODE);

  useEffect(() => {
    if (session?.officeId) void productCategoryService.listCategories(session.officeId);
  }, [session?.officeId]);
  const allCategories = allProductCategoriesInOrder(useProductCategories() ?? []);
  const activeCategories = activeProductCategoriesInOrder(allCategories);
  const categoryByIdMap = categoriesById(allCategories);
  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of allCategories) map.set(c.id, c.name);
    return map;
  }, [allCategories]);

  const withoutLocation = useMemo(() => {
    if (!session) return [];
    return articlesWithoutLocation(officeArticles, session, assignments);
  }, [officeArticles, session, assignments]);

  // Sprint 3.2 §9: dit filter werkt sinds Sprint 3.2 op de canonieke
  // Productgamma (nooit meer de bevroren bronproductgroep) — enkel de
  // productgamma's die effectief in deze werklijst voorkomen.
  const categoriesInList = useMemo(() => {
    const ids = new Set<string>();
    for (const article of withoutLocation) {
      if (article.categoryId) ids.add(article.categoryId);
    }
    return activeCategories.filter((c) => ids.has(c.id));
  }, [withoutLocation, activeCategories]);

  const filtered = useMemo(
    () => filterArticlesForList(withoutLocation, { ...DEFAULT_ARTICLE_LIST_FILTERS, search, category }, new Map()),
    [withoutLocation, search, category],
  );
  const sorted = useMemo(
    () => sortArticlesForList(filtered, sortMode, categoryNameById),
    [filtered, sortMode, categoryNameById],
  );

  const activeLocations = useMemo(() => (office ? activeLocationsInOrder(office) : []), [office]);
  const locationById = useMemo(
    () => new Map((office?.locations ?? []).map((l) => [l.id, l])),
    [office],
  );

  if (!session || !office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  return (
    <div className="stack">
      <h1 className="screen-title">Zonder locatie</h1>
      <p className="screen-subtitle">
        {office.name} — {sorted.length === withoutLocation.length
          ? `${withoutLocation.length} artikelen`
          : `${sorted.length} van ${withoutLocation.length} artikelen`}
      </p>

      <div className="articles-toolbar">
        <input
          className="search-input articles-toolbar__search"
          placeholder="Zoeken..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="search-input articles-toolbar__sort"
          aria-label="Sorteren"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as ArticleListSortMode)}
        >
          {(Object.keys(ARTICLE_LIST_SORT_MODE_LABELS) as ArticleListSortMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {ARTICLE_LIST_SORT_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>

      {categoriesInList.length > 0 && (
        <div className="filter-row">
          <button
            type="button"
            className={`chip ${category === "ALL" ? "chip--active" : ""}`}
            onClick={() => setCategory("ALL")}
          >
            Alle productgamma's
          </button>
          {categoriesInList.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip ${category === c.id ? "chip--active" : ""}`}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <ArticleBulkList
        officeId={office.id}
        articles={sorted}
        activeLocations={activeLocations}
        locationById={locationById}
        locationIdsByArticle={new Map()}
        activeCategories={activeCategories}
        categoriesById={categoryByIdMap}
        onOpenArticle={(articleId) => onOpenArticle(office.id, articleId)}
      />
    </div>
  );
}
