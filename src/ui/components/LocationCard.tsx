import type { Location } from "../../domain/types";

interface LocationCardProps {
  location: Location;
  counted: number;
  total: number;
  onOpen: (location: Location) => void;
  /** Statuslabel (spec v0.2.1 §4): "Nog niet gestart" / "Bezig" / "Afgerond". */
  statusLabel?: string;
}

export function LocationCard({ location, counted, total, onOpen, statusLabel }: LocationCardProps) {
  const done = total > 0 && counted >= total;
  return (
    <button className="location-card" onClick={() => onOpen(location)}>
      <span className="location-card__name">{location.name}</span>
      {statusLabel && <span className="location-card__status">{statusLabel}</span>}
      <span className={done ? "location-card__count location-card__done" : "location-card__count"}>
        {counted} / {total} geteld
      </span>
    </button>
  );
}
