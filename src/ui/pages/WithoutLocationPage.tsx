import { useMemo, useState } from "react";
import {
  DEFAULT_ARTICLE_LIST_FILTERS,
  DEFAULT_ARTICLE_LIST_SORT_MODE,
  ARTICLE_LIST_SORT_MODE_LABELS,
  filterArticlesForList,
  sortArticlesForList,
  type ArticleListSortMode,
} from "../../domain/articleListing";
import { activeLocationsInOrder } from "../../domain/locations";
import { articlesWithoutLocation } from "../../domain/withoutLocation";
import { ArticleBulkList } from "../components/ArticleBulkList";
import { useArticles, useAssignments, useOffice, useSession } from "../hooks/useLiveData";

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
  const [productGroup, setProductGroup] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<ArticleListSortMode>(DEFAULT_ARTICLE_LIST_SORT_MODE);

  const withoutLocation = useMemo(() => {
    if (!session) return [];
    return articlesWithoutLocation(officeArticles, session, assignments);
  }, [officeArticles, session, assignments]);

  const productGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const article of withoutLocation) {
      if (article.productGroup) groups.add(article.productGroup);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b, "nl"));
  }, [withoutLocation]);

  const filtered = useMemo(
    () =>
      filterArticlesForList(
        withoutLocation,
        { ...DEFAULT_ARTICLE_LIST_FILTERS, search, productGroup },
        new Map(),
      ),
    [withoutLocation, search, productGroup],
  );
  const sorted = useMemo(() => sortArticlesForList(filtered, sortMode), [filtered, sortMode]);

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
          ? `${withoutLocation.length} artikels`
          : `${sorted.length} van ${withoutLocation.length} artikels`}
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

      {productGroups.length > 0 && (
        <div className="filter-row">
          <button
            type="button"
            className={`chip ${productGroup === null ? "chip--active" : ""}`}
            onClick={() => setProductGroup(null)}
          >
            Alle productgroepen
          </button>
          {productGroups.map((group) => (
            <button
              key={group}
              type="button"
              className={`chip ${productGroup === group ? "chip--active" : ""}`}
              onClick={() => setProductGroup(group)}
            >
              {group}
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
        onOpenArticle={(articleId) => onOpenArticle(office.id, articleId)}
      />
    </div>
  );
}
