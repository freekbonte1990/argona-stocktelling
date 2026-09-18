interface SummaryTileProps {
  label: string;
  value: number | string;
}

/** Klein statistiekblokje (bv. importoverzicht, reviewscherm-totalen). */
export function SummaryTile({ label, value }: SummaryTileProps) {
  return (
    <div className="summary-tile">
      <div className="summary-tile__value">{value}</div>
      <div className="summary-tile__label">{label}</div>
    </div>
  );
}
