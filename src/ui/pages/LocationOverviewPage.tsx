import { useMemo } from "react";
import type { Location } from "../../domain/types";
import { computeSessionProgress } from "../../domain/progress";
import { LocationCard } from "../components/LocationCard";
import { ProgressBar } from "../components/ProgressBar";
import { BigButton } from "../components/BigButton";
import { useCountEntries, useOffice, useSession } from "../hooks/useLiveData";
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
}

export function LocationOverviewPage({
  sessionId,
  onOpenLocation,
  onOpenReview,
}: LocationOverviewPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const entries = useCountEntries(sessionId);

  const progress = useMemo(() => {
    if (!session || !office) return null;
    return computeSessionProgress(session.articleIds, office.locations, entries ?? []);
  }, [session, office, entries]);

  if (!session || !office || !progress) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

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
        {office.locations.map((location: Location) => {
          const locationProgress = progress.perLocation.find((p) => p.locationId === location.id);
          return (
            <LocationCard
              key={location.id}
              location={location}
              counted={locationProgress?.countedEntries ?? 0}
              total={locationProgress?.totalEntries ?? 0}
              onOpen={() => onOpenLocation(location.id)}
            />
          );
        })}
      </div>
      <BigButton variant="secondary" onClick={onOpenReview}>
        Controleren
      </BigButton>
    </div>
  );
}
