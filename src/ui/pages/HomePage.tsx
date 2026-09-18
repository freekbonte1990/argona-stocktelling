import { BigButton } from "../components/BigButton";
import { useActiveSession, useAllOffices, useOffice } from "../hooks/useLiveData";

interface HomePageProps {
  officeId: string;
  onStartNewSession: () => void;
  onResumeSession: () => void;
  onOpenArticles: () => void;
  onOpenSettings: () => void;
  onSwitchOffice: (officeId: string) => void;
  onImportNewOffice: () => void;
}

export function HomePage({
  officeId,
  onStartNewSession,
  onResumeSession,
  onOpenArticles,
  onOpenSettings,
  onSwitchOffice,
  onImportNewOffice,
}: HomePageProps) {
  const office = useOffice(officeId);
  const allOffices = useAllOffices() ?? [];
  const activeSession = useActiveSession(officeId);

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
    </div>
  );
}
