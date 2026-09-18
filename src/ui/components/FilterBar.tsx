export type CountFilter = "ALL" | "TODO" | "DONE";

interface FilterBarProps {
  filter: CountFilter;
  onFilterChange: (filter: CountFilter) => void;
  productGroups: string[];
  selectedProductGroup: string | null;
  onProductGroupChange: (group: string | null) => void;
}

const FILTER_LABELS: Record<CountFilter, string> = {
  ALL: "Alles",
  TODO: "Nog te tellen",
  DONE: "Geteld",
};

export function FilterBar({
  filter,
  onFilterChange,
  productGroups,
  selectedProductGroup,
  onProductGroupChange,
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
    </div>
  );
}
