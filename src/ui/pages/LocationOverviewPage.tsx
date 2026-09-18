import { useMemo } from "react";
import type { Location } from "../../domain/types";
import { computeSessionProgress } from "../../domain/progress";
import { countSessionService } from "../../application/container";
import { LocationCard } from "../components/LocationCard";
import { ProgressBar } from "../components/ProgressBar";
import { BigButton } from "../components/BigButton";
import { useCountEntries, useOffice, useSession } from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";

interface LocationOverviewPageProps {
  sessionId: string;
  onOpenLocation: (locationId: string) => void;
  onSessionCompleted: () => void;
}

export function LocationOverviewPage({
  sessionId,
  onOpenLocation,
  onSessionCompleted,
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

  const allDone =
    progress.totalUniqueArticles > 0 &&
    progress.completedUniqueArticles === progress.totalUniqueArticles;

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
      {allDone && session.status === "ACTIVE" && (
        <BigButton
          variant="secondary"
          onClick={async () => {
            await countSessionService.completeSession(session.id);
            onSessionCompleted();
          }}
        >
          Telling afronden
        </BigButton>
      )}
    </div>
  );
}
