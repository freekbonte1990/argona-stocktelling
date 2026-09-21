import { ARTICLE_SORT_MODE_LABELS, type ArticleSortMode } from "../../domain/sorting";

/**
 * Filters op het telscherm (spec v0.2.1 §2):
 *   ALL               -> Alles
 *   NOT_COUNTED_ANYWHERE -> nog nergens in deze sessie geteld (geen enkele
 *     locatie-entry én niet bevestigd afwezig) — dus ook niet op een ándere
 *     locatie al afgehandeld.
 *   COUNTED_HERE      -> al geteld OP DEZE locatie specifiek.
 * "Productgroep" is een apart selectievak (zie onder), geen chip hier.
 */
export type CountFilter = "ALL" | "NOT_COUNTED_ANYWHERE" | "COUNTED_HERE";

interface FilterBarProps {
  filter: CountFilter;
  onFilterChange: (filter: CountFilter) => void;
  productGroups: string[];
  selectedProductGroup: string | null;
  onProductGroupChange: (group: string | null) => void;
  /** Optioneel: sorteermodus-kiezer (spec §2) — enkel getoond wanneer meegegeven. */
  sortMode?: ArticleSortMode;
  onSortModeChange?: (mode: ArticleSortMode) => void;
}

const FILTER_LABELS: Record<CountFilter, string> = {
  ALL: "Alles",
  NOT_COUNTED_ANYWHERE: "Nog nergens geteld",
  COUNTED_HERE: "Op deze locatie geteld",
};

export function FilterBar({
  filter,
  onFilterChange,
  productGroups,
  selectedProductGroup,
  onProductGroupChange,
  sortMode,
  onSortModeChange,
}: FilterBarProps) {
  return (
    <div className="stack stack--tight">
      <div className="filter-row">
        {(Object.keys(FILTER_LABELS) as CountFilter[]).map((key) => (
          <button
            key={key}
            className={`chip ${filter === key ? "chip--active" : ""}`}
            onClick={() => onFilterChange(key)}
          >
            {FILTER_LABELS[key]}
          </button>
        ))}
      </div>
      {productGroups.length > 0 && (
        <div className="filter-row">
          <button
            className={`chip ${selectedProductGroup === null ? "chip--active" : ""}`}
            onClick={() => onProductGroupChange(null)}
          >
            Alle productgroepen
          </button>
          {productGroups.map((group) => (
            <button
              key={group}
              className={`chip ${selectedProductGroup === group ? "chip--active" : ""}`}
              onClick={() => onProductGroupChange(group)}
            >
              {group}
            </button>
          ))}
        </div>
      )}
      {sortMode && onSortModeChange && (
        <div className="filter-row">
          <span className="screen-subtitle" style={{ margin: 0, alignSelf: "center" }}>
            Sorteer op:
          </span>
          {(Object.keys(ARTICLE_SORT_MODE_LABELS) as ArticleSortMode[]).map((mode) => (
            <button
              key={mode}
              className={`chip ${sortMode === mode ? "chip--active" : ""}`}
              onClick={() => onSortModeChange(mode)}
            >
              {ARTICLE_SORT_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
