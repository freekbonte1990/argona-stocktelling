interface SummaryTileProps {
  label: string;
  value: number | string;
  /**
   * Visuele-polish-sprint §5: puur presentationeel kleuraccent op de
   * waarde — voor tegels waarvan de betekenis (niet het concrete getal)
   * altijd "positief"/"negatief" is, bv. "Correctie +" vs. "Correctie -".
   * Geen nieuwe berekening, enkel een kleurklasse.
   */
  tone?: "positive" | "negative" | "neutral";
}

/** Klein statistiekblokje (bv. importoverzicht, reviewscherm-totalen). */
export function SummaryTile({ label, value, tone = "neutral" }: SummaryTileProps) {
  return (
    <div className="summary-tile">
      <div className={`summary-tile__value summary-tile__value--${tone}`}>{value}</div>
      <div className="summary-tile__label">{label}</div>
    </div>
  );
}
