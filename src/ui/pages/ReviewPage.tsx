import { useMemo, useState } from "react";
import {
  DEFAULT_REVIEW_SORT_MODE,
  REVIEW_SORT_MODE_LABELS,
  computeSessionArticleTotals,
  computeSessionReview,
  filterReviewResults,
  isSessionReadyToComplete,
  sortReviewResults,
} from "../../domain/review";
import type { ReviewFilter, ReviewSortMode } from "../../domain/review";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
import { countSessionService, countingService, exportService } from "../../application/container";
import { SessionIncompleteError } from "../../application/services/CountSessionService";
import { SheetNameConflictError, type SheetNameConflictResolution } from "../../application/services/ExportService";
import { BigButton } from "../components/BigButton";
import { SummaryTile } from "../components/SummaryTile";
import { ReviewRow } from "../components/ReviewRow";
import {
  useArticles,
  useCountEntries,
  useLocationStatuses,
  useOffice,
  useSession,
  useSessionsForOffice,
} from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";
import { formatEuro } from "../../shared/format";

/** Sentinel voor de vergelijk-dropdown: "geen andere sessie gekozen" = standaardgedrag (Article.previousCount). */
const PREVIOUS_COUNT_SENTINEL = "";

interface ReviewPageProps {
  sessionId: string;
  /** Navigeer naar het telscherm van deze locatie, gefocust op dit artikel. */
  onRecount: (locationId: string, articleId: string) => void;
  /** Na succesvol afronden. */
  onCompleted: () => void;
  /**
   * Naar het locatie-overzicht van deze sessie (spec v0.2.1 §5): voor een
   * artikel dat nog nergens geteld is, is er nog geen locatie om rechtstreeks
   * naar terug te navigeren — de gebruiker kiest zelf een locatie en zoekt
   * het artikel daar op via "+ Bestaand artikel opzoeken".
   */
  onOpenLocationOverview: () => void;
  /**
   * Rechtstreeks naar het telscherm van deze locatie (spec v0.2.1 §6): zodat
   * de gebruiker vanuit de melding "2 locaties zijn nog niet afgerond: ..."
   * meteen naar zo'n locatie kan doorklikken in plaats van eerst terug naar
   * het locatie-overzicht te moeten navigeren.
   */
  onOpenLocation: (locationId: string) => void;
}

const FILTER_LABELS: Record<ReviewFilter, string> = {
  ALL: "Alles",
  DIFFERENCE: "Verschil",
  CONTROL: "Controle",
  NOT_COUNTED: "Niet geteld",
};

/**
 * Reviewscherm (spec v0.2 §1-4, uitgebreid met v0.2.1 §5): overzicht van de
 * sessie, per-artikel resultaten, de sectie "Artikels nergens aangetroffen",
 * en de acties "Telling afronden" en "Exporteren naar Excel". De
 * resultatenberekening zelf gebeurt volledig in domain/review.ts — deze
 * pagina leest enkel reactief (useLiveQuery) en toont het resultaat.
 */
export function ReviewPage({
  sessionId,
  onRecount,
  onCompleted,
  onOpenLocationOverview,
  onOpenLocation,
}: ReviewPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const officeArticles = useArticles(session?.officeId) ?? [];
  const entries = useCountEntries(sessionId) ?? [];
  const locationStatuses = useLocationStatuses(sessionId) ?? [];
  const officeSessions = useSessionsForOffice(session?.officeId) ?? [];

  const [filter, setFilter] = useState<ReviewFilter>("ALL");
  const [sortMode, setSortMode] = useState<ReviewSortMode>(DEFAULT_REVIEW_SORT_MODE);
  // Aanvulling ("je moet hier ook kunnen kiezen om te vergelijken met een
  // willekeurig gekozen telling"): PREVIOUS_COUNT_SENTINEL = standaard
  // (Article.previousCount), anders het gekozen sessieId.
  const [comparisonSessionId, setComparisonSessionId] = useState<string>(PREVIOUS_COUNT_SENTINEL);
  const [completing, setCompleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Aanvulling ("kan je niet vragen om te overschrijven of een andere naam te
  // geven?"): bij een SheetNameConflictError tonen we voortaan een keuze i.p.v.
  // enkel de foutmelding — `conflictSheetName` houdt bij welke naam botst.
  const [conflictSheetName, setConflictSheetName] = useState<string | null>(null);
  const [customSheetName, setCustomSheetName] = useState("");
  const [confirmingAllAbsent, setConfirmingAllAbsent] = useState(false);
  const [confirmingArticleId, setConfirmingArticleId] = useState<string | null>(null);
  // Aanvulling: "Afronden met openstaande artikels" — uitzonderingsflow.
  const [confirmingOutstanding, setConfirmingOutstanding] = useState(false);
  const [completingOutstanding, setCompletingOutstanding] = useState(false);

  // Enkel afgeronde sessies van dit kantoor komen in aanmerking als
  // vergelijkingsbasis, en nooit de sessie die je nu zelf aan het
  // controleren bent (vergelijken met jezelf heeft geen betekenis).
  const comparisonSessions = useMemo(
    () => officeSessions.filter((s) => s.status === "COMPLETED" && s.id !== sessionId),
    [officeSessions, sessionId],
  );
  const comparisonEntries =
    useCountEntries(comparisonSessionId !== PREVIOUS_COUNT_SENTINEL ? comparisonSessionId : undefined) ?? [];
  const comparisonCounts = useMemo(
    () =>
      comparisonSessionId === PREVIOUS_COUNT_SENTINEL
        ? null
        : computeSessionArticleTotals(comparisonEntries),
    [comparisonSessionId, comparisonEntries],
  );
  const comparisonSession = comparisonSessions.find((s) => s.id === comparisonSessionId);
  const comparisonLabel = comparisonSession ? sessionSnapshotName(comparisonSession) : "Vorige telling";

  const review = useMemo(() => {
    if (!session || !office) return null;
    return computeSessionReview(
      session,
      officeArticles,
      office.locations,
      entries,
      locationStatuses,
      comparisonCounts,
    );
  }, [session, office, officeArticles, entries, locationStatuses, comparisonCounts]);

  if (!session || !office || !review) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  const filtered = sortReviewResults(filterReviewResults(review.results, filter), sortMode);
  const ready = isSessionReadyToComplete(review);
  const isCompleted = session.status === "COMPLETED";

  async function handleComplete() {
    setError(null);
    setCompleting(true);
    try {
      await countSessionService.completeSession(sessionId);
      onCompleted();
    } catch (err) {
      if (err instanceof SessionIncompleteError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Onbekende fout bij het afronden.");
      }
    } finally {
      setCompleting(false);
    }
  }

  /**
   * Aanvulling: rondt af via de uitzonderingsflow — geblokkeerde locaties en
   * niet (volledig) getelde artikelen worden NIET gecontroleerd. Enkel
   * bereikbaar via de expliciete bevestigingsdialoog hieronder.
   */
  async function handleCompleteWithOutstanding() {
    setError(null);
    setCompletingOutstanding(true);
    try {
      await countSessionService.completeSessionWithOutstandingArticles(sessionId);
      setConfirmingOutstanding(false);
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het afronden.");
    } finally {
      setCompletingOutstanding(false);
    }
  }

  async function handleExport(resolution?: SheetNameConflictResolution) {
    setError(null);
    setExporting(true);
    try {
      const file = await exportService.exportSessionResults(sessionId, resolution);
      const blob = new Blob([file.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setConflictSheetName(null);
    } catch (err) {
      if (err instanceof SheetNameConflictError) {
        // Toon de keuze (overschrijven / andere naam) i.p.v. enkel de
        // foutmelding — zie de modal hieronder.
        setConflictSheetName(err.sheetName);
        setCustomSheetName(`${err.sheetName} (2)`);
      } else {
        setError(err instanceof Error ? err.message : "Onbekende fout bij het exporteren.");
      }
    } finally {
      setExporting(false);
    }
  }

  const handleConfirmAbsent = async (articleId: string) => {
    setError(null);
    setConfirmingArticleId(null);
    try {
      await countingService.confirmAbsent(session, articleId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het bevestigen.");
    }
  };

  const handleConfirmAllAbsent = async () => {
    setError(null);
    setConfirmingAllAbsent(false);
    try {
      await countingService.confirmAllAbsent(
        session,
        review.notFoundAnywhere.map((r) => r.articleId),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het bevestigen.");
    }
  };

  return (
    <div className="stack">
      <h1 className="screen-title">{SESSION_TYPE_LABELS[session.type] ?? session.type} — controle</h1>
      <p className="screen-subtitle">
        {office.name}
        {isCompleted && session.completedAt
          ? ` · afgerond op ${new Date(session.completedAt).toLocaleDateString("nl-BE")}`
          : ""}
      </p>

      {/*
        Aanvulling ("je moet hier ook kunnen kiezen om te vergelijken met
        een willekeurig gekozen telling"): standaard blijft dit
        Article.previousCount ("Vorige telling"), maar je kan hier een
        andere afgeronde sessie van dit kantoor kiezen als vergelijkings-
        basis — dat verandert dan meteen alle verschillen hieronder, de
        Correctie-tegels én de rijlabels (ReviewRow#comparisonLabel).
        Enkel getoond zodra er effectief iets is om mee te vergelijken.
      */}
      {comparisonSessions.length > 0 && (
        <label className="filter-field">
          <span className="filter-field__label">Vergelijken met</span>
          <select
            className="search-input"
            value={comparisonSessionId}
            onChange={(e) => setComparisonSessionId(e.target.value)}
          >
            <option value={PREVIOUS_COUNT_SENTINEL}>Vorige telling (standaard)</option>
            {comparisonSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionSnapshotName(s)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="summary-grid">
        <SummaryTile
          label="Locaties afgerond"
          value={`${review.completedActiveLocationsCount} / ${review.totalActiveLocations}`}
        />
        <SummaryTile
          label="Artikels afgewerkt"
          value={`${review.countedArticles} / ${review.totalArticlesInScope}`}
        />
        <SummaryTile label="Totaal in scope" value={review.totalArticlesInScope} />
        <SummaryTile label="Geteld" value={review.countedArticles} />
        <SummaryTile label="Niet geteld" value={review.notCountedArticles} />
        <SummaryTile label="Met verschil" value={review.articlesWithDifference} />
        <SummaryTile label="Correctie +" value={review.totalPositiveCorrectionQuantity} />
        <SummaryTile label="Correctie -" value={review.totalNegativeCorrectionQuantity} />
        <SummaryTile label="Correctie + (€)" value={formatEuro(review.totalPositiveCorrectionAmount)} />
        <SummaryTile label="Correctie - (€)" value={formatEuro(review.totalNegativeCorrectionAmount)} />
      </div>

      <div className="filter-row">
        {(Object.keys(FILTER_LABELS) as ReviewFilter[]).map((key) => (
          <button
            key={key}
            className={`chip ${filter === key ? "chip--active" : ""}`}
            onClick={() => setFilter(key)}
          >
            {FILTER_LABELS[key]}
          </button>
        ))}
        {/* Aanvulling: "moet je ook kunnen sorteren op verschil bedrag/kostprijs/verschil aantal (hoog naar laag)". */}
        <select
          className="search-input"
          aria-label="Sorteren"
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as ReviewSortMode)}
        >
          {(Object.keys(REVIEW_SORT_MODE_LABELS) as ReviewSortMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {REVIEW_SORT_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>

      {/*
        Spec v0.2.1 §6: "Telling afronden" is disabled zolang niet BEIDE
        voorwaarden vervuld zijn — deze banner toont ALTIJD duidelijk waarom,
        met voor elke nog-open locatie meteen een link om ze direct te openen
        (in plaats van eerst terug naar het locatie-overzicht te moeten).
      */}
      {!ready && !isCompleted && (
        <div className="warning-banner stack stack--tight">
          {review.incompleteActiveLocations.length > 0 && (
            <div>
              <p style={{ margin: 0 }}>
                De telling kan nog niet worden afgerond.{" "}
                {review.incompleteActiveLocations.length}{" "}
                {review.incompleteActiveLocations.length === 1 ? "locatie is" : "locaties zijn"} nog niet
                afgerond:{" "}
                {review.incompleteActiveLocations.map((location, index) => (
                  <span key={location.id}>
                    {index > 0 ? ", " : ""}
                    <button
                      type="button"
                      className="text-link-button"
                      onClick={() => onOpenLocation(location.id)}
                    >
                      {location.name}
                    </button>
                  </span>
                ))}
                .
              </p>
            </div>
          )}
          {review.notCountedArticles > 0 && (
            <p style={{ margin: 0 }}>
              Nog {review.notCountedArticles} artikel(en) in scope zijn niet (volledig) geteld. Afronden
              is pas mogelijk zodra alles geteld is.
            </p>
          )}
          {/*
            Aanvulling: vóór de uitzonderlijke afronding altijd duidelijk
            zichtbaar maken wat er precies overgenomen zou worden, ook al is
            de bevestigingsdialoog zelf de plek waar je dat effectief bevestigt.
          */}
          <p style={{ margin: 0 }}>
            {review.notCountedArticles} artikel(en) worden overgenomen
            {review.incompleteActiveLocations.length > 0
              ? ` · ${review.incompleteActiveLocations.length} locatie(s) niet afgerond`
              : ""}{" "}
            als je met openstaande artikels afrondt.
          </p>
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="stack">
        {filtered.length === 0 && <p className="empty-state">Geen artikelen voor dit filter.</p>}
        {filtered.map((result) => (
          <ReviewRow
            key={result.articleId}
            result={result}
            locations={office.locations}
            onRecount={onRecount}
            comparisonLabel={comparisonLabel}
            readOnly={isCompleted}
          />
        ))}
      </div>

      {/*
        "Artikels nergens aangetroffen" (spec v0.2.1 §5): pas betrouwbaar
        zodra alle actieve locaties voor deze sessie afgerond zijn. Zolang
        dat niet zo is, tonen we de lijst wel (informatief), maar zijn de
        bevestigingsacties uitgeschakeld — anders sluit je een artikel af als
        "voorraad 0" terwijl het misschien nog op een niet-afgeronde locatie
        ligt.
      */}
      {review.notFoundAnywhere.length > 0 && !isCompleted && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Artikels nergens aangetroffen</h2>
          {!review.allLocationsCompleted && (
            <p className="screen-subtitle" style={{ margin: 0 }}>
              Rond eerst alle locaties af op het locatie-overzicht — pas dan is deze lijst betrouwbaar
              en kan je artikelen bevestigen als "voorraad 0".
            </p>
          )}
          <div className="stack stack--tight">
            {review.notFoundAnywhere.map((result) => (
              <div key={result.articleId} className="review-row review-row--not-counted">
                <div className="review-row__header">
                  <span className="review-row__description">
                    {result.article.description || "(geen omschrijving)"}
                  </span>
                </div>
                <div className="review-row__meta">
                  {result.article.articleNumber}
                  {result.article.productGroup ? ` · ${result.article.productGroup}` : ""}
                </div>
                <div className="filter-row">
                  <button type="button" className="chip" onClick={onOpenLocationOverview}>
                    Alsnog openen/tellen
                  </button>
                  <button
                    type="button"
                    className="chip"
                    disabled={!review.allLocationsCompleted}
                    onClick={() => setConfirmingArticleId(result.articleId)}
                  >
                    Niet aanwezig — voorraad 0
                  </button>
                </div>
              </div>
            ))}
          </div>
          <BigButton
            variant="secondary"
            disabled={!review.allLocationsCompleted}
            onClick={() => setConfirmingAllAbsent(true)}
          >
            Alles bevestigen als voorraad 0 ({review.notFoundAnywhere.length})
          </BigButton>
        </div>
      )}

      {!isCompleted && (
        <BigButton variant="primary" disabled={!ready || completing} onClick={handleComplete}>
          {completing ? "Bezig met afronden..." : "Telling afronden"}
        </BigButton>
      )}
      {!isCompleted && !ready && (
        <BigButton variant="secondary" onClick={() => setConfirmingOutstanding(true)}>
          Afronden met openstaande artikels
        </BigButton>
      )}
      {/*
        Data-integriteit-sprint §2: een officiële export (nieuw benoemd
        tellingtabblad + HISTORIE + previousCount) mag enkel voor een reeds
        AFGERONDE (COMPLETED) sessie — een lopende (ACTIVE) telling exporteert
        hier bewust niet meer stilzwijgend mee (de service-laag blokkeert dit
        toch, zie `ActiveSessionExportError`, maar de knop maakt dat meteen
        duidelijk i.p.v. pas na een klik een foutmelding te tonen).
      */}
      <BigButton
        variant="secondary"
        disabled={exporting || !isCompleted}
        title={!isCompleted ? "Rond de telling eerst af — enkel een afgeronde telling kan geëxporteerd worden." : undefined}
        onClick={() => handleExport()}
      >
        {exporting ? "Bezig met exporteren..." : "Exporteren naar Excel"}
      </BigButton>

      {confirmingArticleId && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>
              Bevestig dat dit artikel nergens werd aangetroffen (voorraad 0)?
            </p>
            <div className="stack">
              <BigButton variant="primary" onClick={() => handleConfirmAbsent(confirmingArticleId)}>
                Bevestigen
              </BigButton>
              <BigButton variant="ghost" onClick={() => setConfirmingArticleId(null)}>
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}

      {confirmingOutstanding && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Afronden met openstaande artikels?</p>
            <p style={{ margin: 0 }}>{review.notCountedArticles} artikel(en) worden overgenomen.</p>
            {review.incompleteActiveLocations.length > 0 && (
              <p style={{ margin: 0 }}>
                {review.incompleteActiveLocations.length} locatie(s) niet afgerond.
              </p>
            )}
            <p style={{ margin: 0 }}>
              Voor deze artikelen wordt de laatst bekende geldige fysieke voorraad overgenomen. Ze worden
              NIET beschouwd als fysiek geteld deze sessie.
            </p>
            {error && <div className="error-banner">{error}</div>}
            <div className="stack">
              <BigButton
                variant="primary"
                disabled={completingOutstanding}
                onClick={handleCompleteWithOutstanding}
              >
                {completingOutstanding ? "Bezig..." : "Afronden en vorige voorraad overnemen"}
              </BigButton>
              <BigButton
                variant="ghost"
                disabled={completingOutstanding}
                onClick={() => setConfirmingOutstanding(false)}
              >
                Terug naar telling
              </BigButton>
            </div>
          </div>
        </div>
      )}

      {confirmingAllAbsent && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>
              Alle {review.notFoundAnywhere.length} nergens-aangetroffen artikelen bevestigen als
              voorraad 0? Dit kan je nadien niet in bulk ongedaan maken.
            </p>
            <div className="stack">
              <BigButton variant="primary" onClick={handleConfirmAllAbsent}>
                Bevestigen
              </BigButton>
              <BigButton variant="ghost" onClick={() => setConfirmingAllAbsent(false)}>
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}

      {/*
        Aanvulling: bij een naamconflict (SheetNameConflictError) niet enkel
        de foutmelding tonen, maar meteen een keuze bieden — overschrijven
        (het bestaande tabblad van die andere telling/import vervangen), of
        deze export onder een andere naam wegschrijven.
      */}
      {conflictSheetName && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Tabbladnaam bestaat al</p>
            <p style={{ margin: 0 }}>
              Er bestaat al een tellingtabblad met de naam "{conflictSheetName}" (van een andere telling
              of import). Dit tabblad wordt nooit stilzwijgend overschreven — kies hieronder wat er moet
              gebeuren.
            </p>
            {error && <div className="error-banner">{error}</div>}
            <div className="stack">
              <BigButton
                variant="primary"
                disabled={exporting}
                onClick={() => handleExport({ action: "overwrite" })}
              >
                {exporting ? "Bezig..." : `"${conflictSheetName}" overschrijven`}
              </BigButton>
              <div className="stack stack--tight">
                <input
                  type="text"
                  className="search-input"
                  value={customSheetName}
                  onChange={(e) => setCustomSheetName(e.target.value)}
                  placeholder="Andere tabbladnaam"
                />
                <BigButton
                  variant="secondary"
                  disabled={exporting || customSheetName.trim().length === 0}
                  onClick={() => handleExport({ action: "rename", sheetName: customSheetName })}
                >
                  {exporting ? "Bezig..." : "Exporteren onder deze naam"}
                </BigButton>
              </div>
              <BigButton
                variant="ghost"
                disabled={exporting}
                onClick={() => {
                  setConflictSheetName(null);
                  setError(null);
                }}
              >
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
