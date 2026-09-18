import { useMemo, useState } from "react";
import { computeSessionReview, filterReviewResults, isSessionReadyToComplete } from "../../domain/review";
import type { ReviewFilter } from "../../domain/review";
import { countSessionService, exportService } from "../../application/container";
import { SessionIncompleteError } from "../../application/services/CountSessionService";
import { BigButton } from "../components/BigButton";
import { SummaryTile } from "../components/SummaryTile";
import { ReviewRow } from "../components/ReviewRow";
import { useArticles, useCountEntries, useOffice, useSession } from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";
import { formatEuro } from "../../shared/format";

interface ReviewPageProps {
  sessionId: string;
  /** Navigeer naar het telscherm van deze locatie, gefocust op dit artikel. */
  onRecount: (locationId: string, articleId: string) => void;
  /** Na succesvol afronden. */
  onCompleted: () => void;
}

const FILTER_LABELS: Record<ReviewFilter, string> = {
  ALL: "Alles",
  DIFFERENCE: "Verschil",
  CONTROL: "Controle",
  NOT_COUNTED: "Niet geteld",
};

/**
 * Reviewscherm (spec v0.2 §1-4): overzicht van de sessie, per-artikel
 * resultaten, en de acties "Telling afronden" en "Exporteren naar Excel".
 * De resultatenberekening zelf gebeurt volledig in domain/review.ts — deze
 * pagina leest enkel reactief (useLiveQuery) en toont het resultaat.
 */
export function ReviewPage({ sessionId, onRecount, onCompleted }: ReviewPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const officeArticles = useArticles(session?.officeId) ?? [];
  const entries = useCountEntries(sessionId) ?? [];

  const [filter, setFilter] = useState<ReviewFilter>("ALL");
  const [completing, setCompleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = useMemo(() => {
    if (!session || !office) return null;
    return computeSessionReview(session, officeArticles, office.locations, entries);
  }, [session, office, officeArticles, entries]);

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

      {!ready && !isCompleted && (
        <div className="warning-banner">
          Nog {review.notCountedArticles} artikel(en) in scope zijn niet (volledig) geteld. Afronden is
          pas mogelijk zodra alles geteld is.
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="stack">
        {filtered.length === 0 && <p className="empty-state">Geen artikelen voor dit filter.</p>}
        {filtered.map((result) => (
          <ReviewRow key={result.articleId} result={result} locations={office.locations} onRecount={onRecount} />
        ))}
      </div>

      {!isCompleted && (
        <BigButton variant="primary" disabled={!ready || completing} onClick={handleComplete}>
          {completing ? "Bezig met afronden..." : "Telling afronden"}
        </BigButton>
      )}
      <BigButton variant="secondary" disabled={exporting} onClick={handleExport}>
        {exporting ? "Bezig met exporteren..." : "Exporteren naar Excel"}
      </BigButton>
    </div>
  );
}
