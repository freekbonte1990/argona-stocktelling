import { useMemo } from "react";
import type { Location } from "../../domain/types";
import { computeSessionProgress } from "../../domain/progress";
import { activeLocationsInOrder } from "../../domain/locations";
import { articlesWithoutLocation } from "../../domain/withoutLocation";
import { LocationCard } from "../components/LocationCard";
import { ProgressBar } from "../components/ProgressBar";
import { BigButton } from "../components/BigButton";
import {
  useArticles,
  useAssignments,
  useCountEntries,
  useLocationStatuses,
  useOffice,
  useSession,
} from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";

interface LocationOverviewPageProps {
  sessionId: string;
  onOpenLocation: (locationId: string) => void;
  /**
   * Naar het reviewscherm (spec v0.2 §1): altijd beschikbaar, ook als de
   * telling nog niet volledig is — het reviewscherm toont dan zelf de
   * waarschuwing en blokkeert enkel het effectieve afronden (§4).
   */
  onOpenReview: () => void;
  /** Naar de "Zonder locatie"-werklijst van deze sessie (v0.2.1 correctieronde §2). */
  onOpenWithoutLocation: () => void;
}

const STATUS_LABELS = {
  NOT_STARTED: "Nog niet gestart",
  IN_PROGRESS: "Bezig",
  COMPLETED: "Afgerond",
} as const;

export function LocationOverviewPage({
  sessionId,
  onOpenLocation,
  onOpenReview,
  onOpenWithoutLocation,
}: LocationOverviewPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const entries = useCountEntries(sessionId);
  const locationStatuses = useLocationStatuses(sessionId) ?? [];
  const officeArticles = useArticles(session?.officeId) ?? [];
  const assignments = useAssignments(session?.officeId) ?? [];

  const progress = useMemo(() => {
    if (!session || !office) return null;
    return computeSessionProgress(session.articleIds, office.locations, entries ?? []);
  }, [session, office, entries]);

  // Enkel actieve locaties tonen (spec v0.2.1 §1): een inactief gemaakte
  // locatie verdwijnt uit nieuwe telacties, maar blijft wel bestaan voor
  // historische data (zie domain/locations.ts).
  const visibleLocations = useMemo(() => (office ? activeLocationsInOrder(office) : []), [office]);

  /**
   * "Zonder locatie" (v0.2.1 correctieronde §2), voor ELKE telling
   * (Maand/Kwartaal/Jaar/Vol). AANNAME (expliciet gevraagd om te
   * documenteren): de kaart wordt ALTIJD getoond, ook bij aantal 0 — dat
   * gedrag is voorspelbaarder dan een kaart die naargelang de tellingstoestand
   * verschijnt/verdwijnt (spec §2 slot: "kies één consistente aanpak").
   */
  const withoutLocationCount = useMemo(() => {
    if (!session) return 0;
    return articlesWithoutLocation(officeArticles, session, assignments).length;
  }, [officeArticles, session, assignments]);

  if (!session || !office || !progress) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  const statusByLocationId = new Map(locationStatuses.map((s) => [s.locationId, s.status]));

  return (
    <div className="stack">
      <h1 className="screen-title">{SESSION_TYPE_LABELS[session.type] ?? session.type}</h1>
      <p className="screen-subtitle">{office.name}</p>
      <ProgressBar
        label="artikels afgewerkt"
        done={progress.completedUniqueArticles}
        total={progress.totalUniqueArticles}
      />
      <div className="location-grid">
        {visibleLocations.map((location: Location) => {
          const locationProgress = progress.perLocation.find((p) => p.locationId === location.id);
          const counted = locationProgress?.countedEntries ?? 0;
          const total = locationProgress?.totalEntries ?? 0;
          const explicitStatus = statusByLocationId.get(location.id);
          const statusKey =
            explicitStatus === "COMPLETED" ? "COMPLETED" : counted > 0 ? "IN_PROGRESS" : "NOT_STARTED";
          return (
            <LocationCard
              key={location.id}
              location={location}
              counted={counted}
              total={total}
              statusLabel={STATUS_LABELS[statusKey]}
              onOpen={() => onOpenLocation(location.id)}
            />
          );
        })}
        <button
          type="button"
          className="location-card location-card--without-location"
          onClick={onOpenWithoutLocation}
        >
          <span className="location-card__name">Zonder locatie</span>
          <span className="location-card__count">{withoutLocationCount} artikels</span>
        </button>
      </div>
      <BigButton variant="secondary" onClick={onOpenReview}>
        Controleren
      </BigButton>
    </div>
  );
}
