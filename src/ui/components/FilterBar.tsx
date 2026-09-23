import { ARTICLE_SORT_MODE_LABELS, type ArticleSortMode } from "../../domain/sorting";
import { COUNT_FILTER_LABELS, type CountFilter } from "../../domain/countView";

export type { CountFilter };

/**
 * Primaire tabs op het telscherm (spec v0.3 §3, uitgebreid uit v0.2.1 §2):
 * "Nog te tellen" / "Alles" / "Geteld" zijn de snelle, primaire tabs voor de
 * dagelijkse telflow; "Nog nergens geteld" is het bestaande v0.2.1-filter
 * (sessiebreed, niet locatiegebonden) en blijft gewoon beschikbaar als
 * vierde optie — spec: "bestaande filters mogen blijven". De labels/volgorde
 * komen uit domain/countView.ts zodat CountingPage en tests dezelfde bron
 * gebruiken.
 */
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
        {(Object.keys(COUNT_FILTER_LABELS) as CountFilter[]).map((key) => (
          <button
            key={key}
            className={`chip chip--primary ${filter === key ? "chip--active" : ""}`}
            onClick={() => onFilterChange(key)}
          >
            {COUNT_FILTER_LABELS[key]}
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
