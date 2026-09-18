import { useEffect, useState } from "react";
import type { CountSessionType } from "../../domain/types";
import { countSessionService } from "../../application/container";
import type { SessionScopePreview } from "../../application/services/CountSessionService";
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

  useEffect(() => {
    let cancelled = false;
    countSessionService.previewScopes(officeId).then((result) => {
      if (!cancelled) setPreviews(result);
    });
    return () => {
      cancelled = true;
    };
  }, [officeId]);

  async function handleStart(sessionType: CountSessionType) {
    setStarting(sessionType);
    try {
      const session = await countSessionService.startSession(officeId, sessionType);
      onStarted(session.id);
    } finally {
      setStarting(null);
    }
  }

  return (
    <div className="stack">
      <h1 className="screen-title">Nieuwe stocktelling</h1>
      <p className="screen-subtitle">Kies welke telling je wil starten.</p>
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
