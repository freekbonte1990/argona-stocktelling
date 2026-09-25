import { useMemo, useState } from "react";
import { computeSessionProgress } from "../../domain/progress";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
import { BigButton } from "../components/BigButton";
import {
  useActiveSession,
  useAllOffices,
  useCountEntries,
  useOffice,
  useSessionsForOffice,
} from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS, SESSION_TYPE_NOUN_LOWER } from "../sessionTypeLabels";
import { formatDate } from "../../shared/format";

interface HomePageProps {
  officeId: string;
  onStartNewSession: () => void;
  onResumeSession: () => void;
  onOpenArticles: () => void;
  onOpenSettings: () => void;
  onSwitchOffice: (officeId: string) => void;
  onImportNewOffice: () => void;
  /** Naar de (alleen-lezen) "Analyse telling" van een afgeronde telling (Sprint 2). */
  onOpenReview: (sessionId: string) => void;
  /** Annuleert de meegegeven (ACTIVE) sessie — sessielogica-fix. */
  onCancelSession: (sessionId: string) => Promise<void>;
}

/** Welk dialoogscherm (indien enig) momenteel getoond wordt bij "Nieuwe telling" op een bezet kantoor. */
type SessionDialog = "none" | "activeSessionWarning" | "cancelConfirm";

export function HomePage({
  officeId,
  onStartNewSession,
  onResumeSession,
  onOpenArticles,
  onOpenSettings,
  onSwitchOffice,
  onImportNewOffice,
  onOpenReview,
  onCancelSession,
}: HomePageProps) {
  const office = useOffice(officeId);
  const allOffices = useAllOffices() ?? [];
  const activeSession = useActiveSession(officeId);
  const activeEntries = useCountEntries(activeSession?.id) ?? [];
  const allSessions = useSessionsForOffice(officeId);
  const completedSessions = allSessions.filter((s) => s.status === "COMPLETED");
  /*
   * UI/UX-fix (Home, spec-item 3): "Geannuleerde tellingen" verdwijnt
   * uitsluitend uit de zichtbare Home-UI — de CANCELLED-records zelf blijven
   * gewoon in de database bestaan (geen `application`/`adapters`-wijziging,
   * puur een render-keuze hier). Er wordt bewust geen `cancelledSessions`
   * meer berekend/gerenderd op dit scherm.
   */

  const [dialog, setDialog] = useState<SessionDialog>("none");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  /**
   * Voortgang van de actieve sessie ("4 / 217 artikelen afgewerkt") — dezelfde
   * berekening als LocationOverviewPage, hier enkel voor het "Lopende
   * telling"-blok/de waarschuwingsdialoog (spec punt 2 en 3).
   */
  const activeProgress = useMemo(() => {
    if (!activeSession || !office) return null;
    return computeSessionProgress(activeSession.articleIds, office.locations, activeEntries);
  }, [activeSession, office, activeEntries]);

  /**
   * "Nieuwe telling" mag NOOIT meer stilzwijgend een bestaande actieve sessie
   * hervatten (sessielogica-fix, punt 1/3): is er een actieve sessie, dan
   * tonen we eerst de waarschuwingsdialoog i.p.v. rechtstreeks naar het
   * typekeuzescherm te navigeren.
   */
  function handleNewSessionClick() {
    if (activeSession) {
      setCancelError(null);
      setDialog("activeSessionWarning");
    } else {
      onStartNewSession();
    }
  }

  async function handleConfirmCancel() {
    if (!activeSession) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancelSession(activeSession.id);
      setDialog("none");
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Onbekende fout bij het annuleren.");
    } finally {
      setCancelling(false);
    }
  }

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
      {activeSession && activeProgress && (
        <div className="card card--accent stack stack--tight">
          <h2 style={{ margin: 0 }}>Lopende telling</h2>
          <p style={{ margin: 0, fontWeight: 700 }}>
            {SESSION_TYPE_LABELS[activeSession.type] ?? activeSession.type}
          </p>
          <p className="screen-subtitle" style={{ margin: 0 }}>
            {activeProgress.completedUniqueArticles} / {activeProgress.totalUniqueArticles} artikelen afgewerkt
          </p>
          <p className="screen-subtitle" style={{ margin: 0 }}>
            Gestart op {formatDate(activeSession.startedAt)}
          </p>
          <BigButton variant="primary" onClick={onResumeSession}>
            Telling hervatten
          </BigButton>
          {/*
            Aanvulling ("een lopende telling moet je kunnen annuleren"): tot nu
            toe was "Telling annuleren" enkel bereikbaar via de omweg
            "Nieuwe telling" -> "Er loopt al een telling"-waarschuwing. Deze
            knop opent dezelfde, al bestaande bevestigingsdialoog
            (`cancelConfirm`) rechtstreeks vanaf de "Lopende telling"-kaart
            zelf — geen nieuwe annuleerlogica, enkel een directere ingang.
          */}
          <BigButton
            variant="subtle"
            onClick={() => {
              setCancelError(null);
              setDialog("cancelConfirm");
            }}
          >
            Telling annuleren
          </BigButton>
        </div>
      )}

      <div className="stack">
        <BigButton variant={activeSession ? "secondary" : "primary"} onClick={handleNewSessionClick}>
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

      {/*
        UI/UX-fix (Home, spec-item 3): "Vorige tellingen" mag de homepage niet
        meer volledig innemen — dezelfde `<details>`-aanpak die voorheen enkel
        voor geannuleerde tellingen gold, wordt nu hiervoor gebruikt: standaard
        samengevouwen (enkel de samenvatting/`summary` zichtbaar), één tik om
        de historiek te bekijken. Puur presentatie — de klikbare
        `session-history-item`-knoppen en `onOpenReview` blijven ongewijzigd.
      */}
      {completedSessions.length > 0 && (
        <div className="stack stack--tight">
          <details className="session-history-collapsible">
            <summary className="screen-subtitle session-history-collapsible__summary" style={{ margin: 0 }}>
              Vorige tellingen ({completedSessions.length})
            </summary>
            <div className="session-history">
              {completedSessions.map((s) => (
                <button
                  key={s.id}
                  className="session-history-item"
                  onClick={() => onOpenReview(s.id)}
                >
                  {/*
                    Sprint 2 §12: naast het type ("Maandtelling") ook meteen de
                    concrete maand/kwartaal/jaar (`sessionSnapshotName`, bv.
                    "2026-09 Maand") — dezelfde naamgeving als het bevroren
                    tellingtabblad en de nieuwe "Analyse telling"-titel, zodat
                    twee tellingen van hetzelfde type onderling meteen te
                    onderscheiden zijn zonder eerst te moeten doorklikken.
                    Puur additief: het bestaande "Maandtelling"-tekstknooppunt
                    blijft ongewijzigd zijn eigen element.
                  */}
                  <span className="stack stack--tight" style={{ gap: 2 }}>
                    <span>{SESSION_TYPE_LABELS[s.type] ?? s.type}</span>
                    <span className="screen-subtitle" style={{ margin: 0 }}>
                      {sessionSnapshotName(s)}
                    </span>
                  </span>
                  <span className="screen-subtitle" style={{ margin: 0 }}>
                    {s.completedAt ? formatDate(s.completedAt) : ""}
                  </span>
                </button>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Spec punt 3: klik op "Nieuwe telling" terwijl er al een actieve sessie loopt. */}
      {dialog === "activeSessionWarning" && activeSession && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Er loopt al een telling</p>
            <p style={{ margin: 0 }}>
              Er loopt momenteel een {SESSION_TYPE_NOUN_LOWER[activeSession.type] ?? activeSession.type} voor{" "}
              {office?.name ?? "dit kantoor"}.
            </p>
            {activeProgress && (
              <p className="screen-subtitle" style={{ margin: 0 }}>
                {activeProgress.completedUniqueArticles} / {activeProgress.totalUniqueArticles} artikelen afgewerkt
              </p>
            )}
            <div className="stack">
              <BigButton
                variant="primary"
                onClick={() => {
                  setDialog("none");
                  onResumeSession();
                }}
              >
                Telling hervatten
              </BigButton>
              <BigButton variant="secondary" onClick={() => setDialog("cancelConfirm")}>
                Telling annuleren
              </BigButton>
              <BigButton variant="ghost" onClick={() => setDialog("none")}>
                Sluiten
              </BigButton>
            </div>
          </div>
        </div>
      )}

      {/* Spec punt 4: "Telling annuleren" is een bewuste actie met bevestiging. */}
      {dialog === "cancelConfirm" && activeSession && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Telling annuleren?</p>
            <p style={{ margin: 0 }}>
              Deze telling wordt niet opgenomen in de officiële voorraadhistoriek. Reeds ingevoerde tellingen
              blijven intern bewaard, maar tellen niet mee als afgeronde stocktelling.
            </p>
            {cancelError && <div className="error-banner">{cancelError}</div>}
            <div className="stack">
              <BigButton variant="primary" disabled={cancelling} onClick={handleConfirmCancel}>
                {cancelling ? "Bezig..." : "Ja, telling annuleren"}
              </BigButton>
              {/*
                Aanvulling: "Terug" sluit voortaan gewoon de dialoog i.p.v.
                altijd terug te springen naar de "Er loopt al een
                telling"-waarschuwing — deze bevestiging is nu ook rechtstreeks
                bereikbaar vanaf de "Lopende telling"-kaart, zonder die
                waarschuwing ooit gezien te hebben.
              */}
              <BigButton variant="ghost" disabled={cancelling} onClick={() => setDialog("none")}>
                Terug
              </BigButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
