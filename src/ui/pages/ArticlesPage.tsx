import { useMemo, useState } from "react";
import {
  ARTICLE_LIST_SORT_MODE_LABELS,
  ARTICLE_STATUS_FILTER_LABELS,
  DEFAULT_ARTICLE_LIST_FILTERS,
  DEFAULT_ARTICLE_LIST_SORT_MODE,
  FREQUENCY_FILTER_LABELS,
  countActiveArticleListFilters,
  filterArticlesForList,
  sortArticlesForList,
  type ArticleListFilters,
  type ArticleListSortMode,
  type ArticleLocationFilterValue,
} from "../../domain/articleListing";
import { activeLocationsInOrder } from "../../domain/locations";
import type { ArticleActiveStatus, ArticleCountFrequency } from "../../domain/types";
import { ArticleBulkList } from "../components/ArticleBulkList";
import { BigButton } from "../components/BigButton";
import { NewArticleModal } from "../components/NewArticleModal";
import { useArticles, useAssignments, useOffice } from "../hooks/useLiveData";

interface ArticlesPageProps {
  officeId: string;
  onOpenArticle: (articleId: string) => void;
}

/**
 * Artikels-overzicht (v0.2.1 correctieronde §1): een compacte toolbar
 * (zoeken / sorteren / "Filters (N)" / "+ Nieuw artikel") in plaats van
 * tientallen permanent zichtbare filterknoppen. De onderliggende
 * bulklocatiefunctionaliteit (checkboxes, bulkbalk, locatiechips per rij,
 * quick "+ Locatie") is ONGEWIJZIGD en zit nu in het gedeelde
 * `ArticleBulkList`-component — er is bewust GEEN nieuwe
 * locatietoewijsmodus gebouwd.
 */
export function ArticlesPage({ officeId, onOpenArticle }: ArticlesPageProps) {
  const articles = useArticles(officeId) ?? [];
  const office = useOffice(officeId);
  const assignments = useAssignments(officeId) ?? [];

  const [filters, setFilters] = useState<ArticleListFilters>(DEFAULT_ARTICLE_LIST_FILTERS);
  const [sortMode, setSortMode] = useState<ArticleListSortMode>(DEFAULT_ARTICLE_LIST_SORT_MODE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [newArticleOpen, setNewArticleOpen] = useState(false);

  const activeLocations = useMemo(() => (office ? activeLocationsInOrder(office) : []), [office]);
  const locationById = useMemo(
    () => new Map((office?.locations ?? []).map((l) => [l.id, l])),
    [office],
  );

  /** Actieve locatie-ID's per artikel (spec §6: "Geen locatie"-filter, en de chips per rij). */
  const locationIdsByArticle = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const assignment of assignments) {
      if (!assignment.active) continue;
      const set = map.get(assignment.articleId);
      if (set) {
        set.add(assignment.locationId);
      } else {
        map.set(assignment.articleId, new Set([assignment.locationId]));
      }
    }
    return map;
  }, [assignments]);

  const productGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const article of articles) {
      if (article.productGroup) groups.add(article.productGroup);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b, "nl"));
  }, [articles]);

  const filtered = useMemo(
    () => filterArticlesForList(articles, filters, locationIdsByArticle),
    [articles, filters, locationIdsByArticle],
  );
  const sorted = useMemo(() => sortArticlesForList(filtered, sortMode), [filtered, sortMode]);

  const activeFilterCount = countActiveArticleListFilters(filters);

  if (!office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  const locationFilterLabel =
    filters.location === "ALL"
      ? null
      : filters.location === "NONE"
        ? "Geen locatie"
        : locationById.get(filters.location)?.name ?? filters.location;

  return (
    <div className="stack">
      <h1 className="screen-title">Artikels</h1>
      <p className="screen-subtitle">
        {sorted.length === articles.length
          ? `${articles.length} artikelen`
          : `${sorted.length} van ${articles.length} artikelen`}
      </p>

      <div className="articles-toolbar">
        <input
          className="search-input articles-toolbar__search"
          placeholder="Zoeken..."
          value={filters.search}
          onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
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
        <button type="button" className="chip articles-toolbar__filters" onClick={() => setFiltersOpen(true)}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
        <BigButton
          variant="secondary"
          style={{ width: "auto" }}
          className="articles-toolbar__new"
          onClick={() => setNewArticleOpen(true)}
        >
          + Nieuw artikel
        </BigButton>
      </div>

      {activeFilterCount > 0 && (
        <div className="filter-row">
          {filters.productGroup && (
            <RemovableChip
              label={`Productgroep: ${filters.productGroup}`}
              onRemove={() => setFilters((prev) => ({ ...prev, productGroup: null }))}
            />
          )}
          {filters.countPeriod && (
            <RemovableChip
              label={`Telfrequentie: ${FREQUENCY_FILTER_LABELS[filters.countPeriod]}`}
              onRemove={() => setFilters((prev) => ({ ...prev, countPeriod: null }))}
            />
          )}
          {locationFilterLabel && (
            <RemovableChip
              label={`Locatie: ${locationFilterLabel}`}
              onRemove={() => setFilters((prev) => ({ ...prev, location: "ALL" }))}
            />
          )}
          {filters.status && (
            <RemovableChip
              label={`Status: ${ARTICLE_STATUS_FILTER_LABELS[filters.status]}`}
              onRemove={() => setFilters((prev) => ({ ...prev, status: null }))}
            />
          )}
        </div>
      )}

      <ArticleBulkList
        officeId={officeId}
        articles={sorted}
        activeLocations={activeLocations}
        locationById={locationById}
        locationIdsByArticle={locationIdsByArticle}
        onOpenArticle={onOpenArticle}
      />

      {filtersOpen && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Filters</p>

            <div className="stack stack--tight">
              {productGroups.length > 0 && (
                <div className="filter-row">
                  <button
                    type="button"
                    className={`chip ${filters.productGroup === null ? "chip--active" : ""}`}
                    onClick={() => setFilters((prev) => ({ ...prev, productGroup: null }))}
                  >
                    Alle productgroepen
                  </button>
                  {productGroups.map((group) => (
                    <button
                      key={group}
                      type="button"
                      className={`chip ${filters.productGroup === group ? "chip--active" : ""}`}
                      onClick={() => setFilters((prev) => ({ ...prev, productGroup: group }))}
                    >
                      {group}
                    </button>
                  ))}
                </div>
              )}

              <div className="filter-row">
                <button
                  type="button"
                  className={`chip ${filters.countPeriod === null ? "chip--active" : ""}`}
                  onClick={() => setFilters((prev) => ({ ...prev, countPeriod: null }))}
                >
                  Alle telfrequenties
                </button>
                {(Object.keys(FREQUENCY_FILTER_LABELS) as ArticleCountFrequency[]).map((period) => (
                  <button
                    key={period}
                    type="button"
                    className={`chip ${filters.countPeriod === period ? "chip--active" : ""}`}
                    onClick={() => setFilters((prev) => ({ ...prev, countPeriod: period }))}
                  >
                    {FREQUENCY_FILTER_LABELS[period]}
                  </button>
                ))}
              </div>

              <div className="filter-row">
                <button
                  type="button"
                  className={`chip ${filters.location === "ALL" ? "chip--active" : ""}`}
                  onClick={() => setFilters((prev) => ({ ...prev, location: "ALL" }))}
                >
                  Alle locaties
                </button>
                <button
                  type="button"
                  className={`chip ${filters.location === "NONE" ? "chip--active" : ""}`}
                  onClick={() => setFilters((prev) => ({ ...prev, location: "NONE" }))}
                >
                  Geen locatie
                </button>
                {activeLocations.map((location) => (
                  <button
                    key={location.id}
                    type="button"
                    className={`chip ${filters.location === location.id ? "chip--active" : ""}`}
                    onClick={() =>
                      setFilters((prev) => ({ ...prev, location: location.id as ArticleLocationFilterValue }))
                    }
                  >
                    {location.name}
                  </button>
                ))}
              </div>

              <div className="filter-row">
                <button
                  type="button"
                  className={`chip ${filters.status === null ? "chip--active" : ""}`}
                  onClick={() => setFilters((prev) => ({ ...prev, status: null }))}
                >
                  Alle statussen
                </button>
                {(Object.keys(ARTICLE_STATUS_FILTER_LABELS) as ArticleActiveStatus[]).map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`chip ${filters.status === status ? "chip--active" : ""}`}
                    onClick={() => setFilters((prev) => ({ ...prev, status }))}
                  >
                    {ARTICLE_STATUS_FILTER_LABELS[status]}
                  </button>
                ))}
              </div>
            </div>

            <BigButton variant="primary" onClick={() => setFiltersOpen(false)}>
              Toepassen
            </BigButton>
          </div>
        </div>
      )}

      {newArticleOpen && (
        <NewArticleModal
          officeId={officeId}
          activeLocations={activeLocations}
          onClose={() => setNewArticleOpen(false)}
          onCreated={() => setNewArticleOpen(false)}
        />
      )}
    </div>
  );
}

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="chip chip--active location-chip">
      <span>{label}</span>
      <button type="button" className="location-chip__remove" aria-label={`${label} wissen`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}
