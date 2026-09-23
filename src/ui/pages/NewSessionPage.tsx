import { useEffect, useState } from "react";
import type { CountSessionType } from "../../domain/types";
import { countSessionService } from "../../application/container";
import type { SessionScopePreview } from "../../application/services/CountSessionService";
import { ActiveSessionExistsError } from "../../application/services/CountSessionService";
import { BigButton } from "../components/BigButton";

interface NewSessionPageProps {
  officeId: string;
  onStarted: (sessionId: string) => void;
}

const LABELS: Record<CountSessionType, string> = {
  MONTHLY: "Maand",
  QUARTERLY: "Kwartaal",
  YEARLY: "Jaar",
  FULL: "Volledige telling",
};

export function NewSessionPage({ officeId, onStarted }: NewSessionPageProps) {
  const [previews, setPreviews] = useState<SessionScopePreview[] | null>(null);
  const [starting, setStarting] = useState<CountSessionType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    countSessionService.previewScopes(officeId).then((result) => {
      if (!cancelled) setPreviews(result);
    });
    return () => {
      cancelled = true;
    };
  }, [officeId]);

  /**
   * Sessielogica-fix: `startSession` gooit nu `ActiveSessionExistsError` in
   * plaats van stilzwijgend een bestaande sessie terug te geven. Dit scherm
   * is enkel bereikbaar wanneer HomePage al vaststelde dat er GEEN actieve
   * sessie was, dus dit vangt normaal enkel een zeldzame race (bv. een
   * andere sessie/tab die net een sessie startte) op — met een duidelijke
   * melding i.p.v. een crash.
   */
  async function handleStart(sessionType: CountSessionType) {
    setStarting(sessionType);
    setError(null);
    try {
      const session = await countSessionService.startSession(officeId, sessionType);
      onStarted(session.id);
    } catch (err) {
      if (err instanceof ActiveSessionExistsError) {
        setError(
          "Er is intussen al een andere telling gestart voor dit kantoor. Ga terug naar het hoofdscherm om die te hervatten of te annuleren.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Onbekende fout bij het starten van de telling.");
      }
    } finally {
      setStarting(null);
    }
  }

  return (
    <div className="stack">
      <h1 className="screen-title">Nieuwe stocktelling</h1>
      <p className="screen-subtitle">Kies welke telling je wil starten.</p>
      {error && <div className="error-banner">{error}</div>}
      <div className="stack">
        {(["MONTHLY", "QUARTERLY", "YEARLY", "FULL"] as CountSessionType[]).map((type) => {
          const preview = previews?.find((p) => p.sessionType === type);
          const count = preview?.articleCount;
          return (
            <BigButton
              key={type}
              variant="secondary"
              disabled={starting !== null}
              onClick={() => handleStart(type)}
            >
              {starting === type
                ? "Bezig met starten..."
                : `${LABELS[type]}${count !== undefined ? ` — ${count} artikelen` : ""}`}
            </BigButton>
          );
        })}
      </div>
    </div>
  );
}
