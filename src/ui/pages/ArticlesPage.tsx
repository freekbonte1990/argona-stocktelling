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

      {/*
       * Aanvulling ("filters ziet er niet goed uit... dropdown per
       * categorie?"): de vroegere chip-grid (elke productgroep/locatie als
       * eigen los knopje) werd onoverzichtelijk zodra er veel opties waren.
       * Eén `<select>` per categorie is compacter, en is exact hetzelfde
       * patroon als elders in de app (bv. de sorteer-dropdown in de
       * toolbar hierboven, of Telperiode/Status op de artikeldetailpagina).
       */}
      {filtersOpen && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Filters</p>

            <div className="stack">
              {productGroups.length > 0 && (
                <label className="filter-field">
                  <span className="filter-field__label">Productgroep</span>
                  <select
                    className="search-input"
                    value={filters.productGroup ?? ""}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, productGroup: e.target.value || null }))
                    }
                  >
                    <option value="">Alle productgroepen</option>
                    {productGroups.map((group) => (
                      <option key={group} value={group}>
                        {group}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="filter-field">
                <span className="filter-field__label">Telfrequentie</span>
                <select
                  className="search-input"
                  value={filters.countPeriod ?? ""}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      countPeriod: (e.target.value || null) as ArticleCountFrequency | null,
                    }))
                  }
                >
                  <option value="">Alle telfrequenties</option>
                  {(Object.keys(FREQUENCY_FILTER_LABELS) as ArticleCountFrequency[]).map((period) => (
                    <option key={period} value={period}>
                      {FREQUENCY_FILTER_LABELS[period]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="filter-field">
                <span className="filter-field__label">Locatie</span>
                <select
                  className="search-input"
                  value={filters.location}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, location: e.target.value as ArticleLocationFilterValue }))
                  }
                >
                  <option value="ALL">Alle locaties</option>
                  <option value="NONE">Geen locatie</option>
                  {activeLocations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="filter-field">
                <span className="filter-field__label">Status</span>
                <select
                  className="search-input"
                  value={filters.status ?? ""}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      status: (e.target.value || null) as ArticleActiveStatus | null,
                    }))
                  }
                >
                  <option value="">Alle statussen</option>
                  {(Object.keys(ARTICLE_STATUS_FILTER_LABELS) as ArticleActiveStatus[]).map((status) => (
                    <option key={status} value={status}>
                      {ARTICLE_STATUS_FILTER_LABELS[status]}
                    </option>
                  ))}
                </select>
              </label>
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
