import { useMemo, useState } from "react";
import { computeSessionReview, filterReviewResults, isSessionReadyToComplete } from "../../domain/review";
import type { ReviewFilter } from "../../domain/review";
import { countSessionService, countingService, exportService } from "../../application/container";
import { SessionIncompleteError } from "../../application/services/CountSessionService";
import { BigButton } from "../components/BigButton";
import { SummaryTile } from "../components/SummaryTile";
import { ReviewRow } from "../components/ReviewRow";
import {
  useArticles,
  useCountEntries,
  useLocationStatuses,
  useOffice,
  useSession,
} from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";
import { formatEuro } from "../../shared/format";

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

  const [filter, setFilter] = useState<ReviewFilter>("ALL");
  const [completing, setCompleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingAllAbsent, setConfirmingAllAbsent] = useState(false);
  const [confirmingArticleId, setConfirmingArticleId] = useState<string | null>(null);

  const review = useMemo(() => {
    if (!session || !office) return null;
    return computeSessionReview(session, officeArticles, office.locations, entries, locationStatuses);
  }, [session, office, officeArticles, entries, locationStatuses]);

  if (!session || !office || !review) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  const filtered = filterReviewResults(review.results, filter);
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

  async function handleExport() {
    setError(null);
    setExporting(true);
    try {
      const file = await exportService.exportSessionResults(sessionId);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het exporteren.");
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
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="stack">
        {filtered.length === 0 && <p className="empty-state">Geen artikelen voor dit filter.</p>}
        {filtered.map((result) => (
          <ReviewRow key={result.articleId} result={result} locations={office.locations} onRecount={onRecount} />
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
      <BigButton variant="secondary" disabled={exporting} onClick={handleExport}>
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
    </div>
  );
}
