import { BigButton } from "../components/BigButton";
import { useActiveSession, useAllOffices, useOffice, useSessionsForOffice } from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";

interface HomePageProps {
  officeId: string;
  onStartNewSession: () => void;
  onResumeSession: () => void;
  onOpenArticles: () => void;
  onOpenSettings: () => void;
  onSwitchOffice: (officeId: string) => void;
  onImportNewOffice: () => void;
  /** Naar het (read-only) reviewscherm van een afgeronde telling. */
  onOpenReview: (sessionId: string) => void;
}

export function HomePage({
  officeId,
  onStartNewSession,
  onResumeSession,
  onOpenArticles,
  onOpenSettings,
  onSwitchOffice,
  onImportNewOffice,
  onOpenReview,
}: HomePageProps) {
  const office = useOffice(officeId);
  const allOffices = useAllOffices() ?? [];
  const activeSession = useActiveSession(officeId);
  const allSessions = useSessionsForOffice(officeId);
  const completedSessions = allSessions.filter((s) => s.status === "COMPLETED");

  return (
    <div className="stack">
      <h1 className="screen-title">Argona Stocktelling</h1>
      <label className="stack stack--tight">
        <span className="screen-subtitle" style={{ margin: 0 }}>
          Kantoor
        </span>
        <select
          className="search-input office-select"
          value={officeId}
          onChange={(e) => onSwitchOffice(e.target.value)}
        >
          {allOffices.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <div className="stack">
        {activeSession && (
          <BigButton variant="primary" onClick={onResumeSession}>
            Telling hervatten
          </BigButton>
        )}
        <BigButton variant={activeSession ? "secondary" : "primary"} onClick={onStartNewSession}>
          Nieuwe telling
        </BigButton>
        <BigButton variant="ghost" onClick={onOpenArticles}>
          Artikels
        </BigButton>
        <BigButton variant="ghost" onClick={onOpenSettings}>
          Instellingen
        </BigButton>
        <BigButton variant="ghost" onClick={onImportNewOffice}>
          + Ander kantoor importeren
        </BigButton>
      </div>
      {!office && <p className="screen-subtitle">Kantoor wordt geladen...</p>}

      {completedSessions.length > 0 && (
        <div className="stack stack--tight">
          <span className="screen-subtitle" style={{ margin: 0 }}>
            Vorige tellingen
          </span>
          <div className="session-history">
            {completedSessions.map((s) => (
              <button
                key={s.id}
                className="session-history-item"
                onClick={() => onOpenReview(s.id)}
              >
                <span>{SESSION_TYPE_LABELS[s.type] ?? s.type}</span>
                <span className="screen-subtitle" style={{ margin: 0 }}>
                  {s.completedAt ? new Date(s.completedAt).toLocaleDateString("nl-BE") : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
