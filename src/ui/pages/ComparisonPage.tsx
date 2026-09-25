import { useEffect, useMemo, useState } from "react";
import {
  ARTICLE_COMPARISON_SORT_MODE_LABELS,
  CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD,
  DEFAULT_ARTICLE_COMPARISON_FILTERS,
  filterArticleComparisonRows,
  sortArticleComparisonRows,
  type ArticleComparisonFilters,
  type ArticleComparisonRow,
  type ArticleComparisonSortMode,
  type MoverRow,
  type SessionComparison,
} from "../../domain/comparison";
import { STOCK_CLASSIFICATION_LABELS } from "../../domain/stockClassification";
import type { StockClassification } from "../../domain/types";
import {
  ComparisonNotAvailableError,
  ComparisonOfficeMismatchError,
  ComparisonSessionNotFoundError,
  type ComparisonSessionOption,
} from "../../application/services/ComparisonService";
import { comparisonService } from "../../application/container";
import { SummaryTile } from "../components/SummaryTile";
import { useOffice, useSession } from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";
import { formatCount, formatDate, formatEuro, formatSignedCount, formatSignedEuro } from "../../shared/format";

interface ComparisonPageProps {
  /** De sessie van waaruit "Vergelijken" geopend werd — wordt de default telling B (spec §2). */
  sessionId: string;
  onOpenArticle: (articleId: string) => void;
  /** Terug naar de bestaande "Analyse telling" (Sprint 2) van de meegegeven sessie. */
  onOpenAnalysis: (sessionId: string) => void;
}

const DETAIL_TABLE_ANCHOR_ID = "comparison-article-list";

function formatSignedPercentDisplay(value: number | null): string {
  if (value === null) return "—";
  const formatted = Math.abs(value).toFixed(1);
  if (value > 0) return `+${formatted}%`;
  if (value < 0) return `-${formatted}%`;
  return `${formatted}%`;
}

const DRIVER_LABELS: Record<MoverRow["driver"], string> = {
  QUANTITY: "Door hoeveelheid",
  COST_PRICE: "Door kostprijs",
  BOTH: "Hoeveelheid + kostprijs",
  UNKNOWN: "Onbekend",
};

/**
 * "Vergelijken" (Sprint 3): read-only vergelijking tussen twee AFGERONDE
 * stocktellingen van hetzelfde kantoor. Zelfde architectuur als
 * `AnalysisPage`: haalt een reeds bevroren resultaat op via
 * `ComparisonService` (die zelf uitsluitend bevroren `FinalizedSessionResult`s
 * leest, nooit levende `Article`-data) — geen enkele telactie, geen writes.
 */
export function ComparisonPage({ sessionId, onOpenArticle, onOpenAnalysis }: ComparisonPageProps) {
  const openedFromSession = useSession(sessionId);
  const officeId = openedFromSession?.officeId;
  const office = useOffice(officeId);

  const [options, setOptions] = useState<ComparisonSessionOption[]>([]);
  const [hasLegacySessions, setHasLegacySessions] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [sessionIdB, setSessionIdB] = useState<string>(sessionId);
  const [sessionIdA, setSessionIdA] = useState<string | null>(null);
  const [defaultsResolved, setDefaultsResolved] = useState(false);

  // Sessiekeuze ophalen — spec §2/§3: enkel COMPLETED sessies van hetzelfde
  // kantoor MET betrouwbare, bevroren data.
  useEffect(() => {
    if (!officeId) return;
    let cancelled = false;
    comparisonService
      .getComparisonOptions(officeId)
      .then((result) => {
        if (cancelled) return;
        setOptions(result.sessions);
        setHasLegacySessions(result.hasLegacySessions);
      })
      .catch((err) => {
        if (cancelled) return;
        setOptionsError(err instanceof Error ? err.message : "Onbekende fout bij het laden van de tellingen.");
      });
    return () => {
      cancelled = true;
    };
  }, [officeId]);

  // Default A/B (spec §2) — enkel ÉÉN keer bepaald bij het openen vanuit
  // `sessionId`; daarna mag de gebruiker beide vrij wijzigen zonder dat dit
  // opnieuw overschreven wordt.
  useEffect(() => {
    if (!officeId || defaultsResolved) return;
    let cancelled = false;
    comparisonService.getDefaultSelection(officeId, sessionId).then((selection) => {
      if (cancelled) return;
      setSessionIdB(selection.sessionIdB);
      setSessionIdA(selection.sessionIdA);
      setDefaultsResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [officeId, sessionId, defaultsResolved]);

  const [comparison, setComparison] = useState<SessionComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionIdA || !sessionIdB) {
      setComparison(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    comparisonService
      .compareSessions(sessionIdA, sessionIdB)
      .then((result) => {
        if (!cancelled) setComparison(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setComparison(null);
        setLoadError(
          err instanceof ComparisonSessionNotFoundError ||
            err instanceof ComparisonNotAvailableError ||
            err instanceof ComparisonOfficeMismatchError ||
            err instanceof Error
            ? err.message
            : "Onbekende fout bij het vergelijken.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionIdA, sessionIdB]);

  const [filters, setFilters] = useState<ArticleComparisonFilters>(DEFAULT_ARTICLE_COMPARISON_FILTERS);
  const [sortMode, setSortMode] = useState<ArticleComparisonSortMode>("VALUE_DIFF_DESC");

  const filteredArticles = useMemo(
    () =>
      comparison
        ? sortArticleComparisonRows(filterArticleComparisonRows(comparison.articles, filters), sortMode)
        : [],
    [comparison, filters, sortMode],
  );

  function scrollToDetailTable() {
    document.getElementById(DETAIL_TABLE_ANCHOR_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function applyFilter(next: Partial<ArticleComparisonFilters>, sort?: ArticleComparisonSortMode) {
    setFilters({ ...DEFAULT_ARTICLE_COMPARISON_FILTERS, ...next });
    if (sort) setSortMode(sort);
    scrollToDetailTable();
  }

  if (!office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  return (
    <div className="stack analysis-page">
      <h1 className="screen-title">
        Vergelijking tellingen
        <span className="readonly-badge">Alleen-lezen</span>
      </h1>
      <p className="screen-subtitle">{office.name}</p>

      <div className="mode-toggle">
        <button type="button" className="mode-toggle__button" onClick={() => onOpenAnalysis(sessionIdB)}>
          Analyse
        </button>
        <span className="mode-toggle__button mode-toggle__button--active">Vergelijken</span>
      </div>

      {optionsError && <div className="error-banner">{optionsError}</div>}

      <div className="card stack stack--tight">
        <div className="comparison-session-picker">
          <label className="stack stack--tight comparison-session-picker__session">
            <span className="screen-subtitle" style={{ margin: 0 }}>
              Telling A
            </span>
            <select
              className="search-input"
              value={sessionIdA ?? ""}
              onChange={(e) => setSessionIdA(e.target.value || null)}
            >
              <option value="" disabled>
                Kies een telling...
              </option>
              {options.map((s) => (
                <option key={s.sessionId} value={s.sessionId} disabled={s.sessionId === sessionIdB}>
                  {SESSION_TYPE_LABELS[s.sessionType] ?? s.sessionType} — {s.sessionName}
                  {s.completedAt ? ` (${formatDate(s.completedAt)})` : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="comparison-session-picker__arrow" aria-hidden="true">
            ↔
          </span>
          <label className="stack stack--tight comparison-session-picker__session">
            <span className="screen-subtitle" style={{ margin: 0 }}>
              Telling B
            </span>
            <select className="search-input" value={sessionIdB} onChange={(e) => setSessionIdB(e.target.value)}>
              {options.map((s) => (
                <option key={s.sessionId} value={s.sessionId} disabled={s.sessionId === sessionIdA}>
                  {SESSION_TYPE_LABELS[s.sessionType] ?? s.sessionType} — {s.sessionName}
                  {s.completedAt ? ` (${formatDate(s.completedAt)})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {hasLegacySessions && (
          <p className="screen-subtitle" style={{ margin: 0 }}>
            Eén of meer oudere tellingen van dit kantoor hebben geen betrouwbare historische data (van vóór de
            data-integriteitsverbetering) en zijn daarom niet beschikbaar om te vergelijken.
          </p>
        )}
        {!sessionIdA && !loadError && defaultsResolved && (
          <p className="screen-subtitle" style={{ margin: 0 }}>
            Geen eerdere bruikbare telling gevonden — kies zelf telling A.
          </p>
        )}
      </div>

      {loading && <p className="screen-subtitle">Bezig met vergelijken...</p>}
      {loadError && <div className="error-banner">{loadError}</div>}

      {comparison && (
        <ComparisonBody
          comparison={comparison}
          filters={filters}
          setFilters={setFilters}
          sortMode={sortMode}
          setSortMode={setSortMode}
          filteredArticles={filteredArticles}
          onOpenArticle={onOpenArticle}
          onFilterProductGroup={(group) => applyFilter({ productGroup: group })}
          onFilterState={(state) => applyFilter({ state }, "VALUE_DIFF_DESC")}
        />
      )}
    </div>
  );
}

function ComparisonBody({
  comparison,
  filters,
  setFilters,
  sortMode,
  setSortMode,
  filteredArticles,
  onOpenArticle,
  onFilterProductGroup,
  onFilterState,
}: {
  comparison: SessionComparison;
  filters: ArticleComparisonFilters;
  setFilters: React.Dispatch<React.SetStateAction<ArticleComparisonFilters>>;
  sortMode: ArticleComparisonSortMode;
  setSortMode: React.Dispatch<React.SetStateAction<ArticleComparisonSortMode>>;
  filteredArticles: ArticleComparisonRow[];
  onOpenArticle: (articleId: string) => void;
  onFilterProductGroup: (group: string) => void;
  onFilterState: (state: ArticleComparisonFilters["state"]) => void;
}) {
  const { headerA, headerB, kpis, productGroups, movers, unchanged, obsoleteCandidates, obsoleteTransitions, transitionCounts, attentionPoints, articles } = comparison;

  return (
    <>
      <p className="screen-subtitle" style={{ margin: 0 }}>
        <strong>A:</strong> {headerA.sessionName}
        {headerA.completedAt ? ` (afgerond op ${formatDate(headerA.completedAt)})` : ""}
        {" · "}
        <strong>B:</strong> {headerB.sessionName}
        {headerB.completedAt ? ` (afgerond op ${formatDate(headerB.completedAt)})` : ""}
      </p>

      {/* Hoofd-KPI's (spec §4). */}
      <div className="stack stack--tight review-summary">
        <div className="summary-group">
          <p className="summary-group__label">Totale voorraadwaarde</p>
          <div className="summary-grid summary-grid--hero">
            <SummaryTile label="Waarde A" value={formatEuro(kpis.stockValue.valueA)} />
            <SummaryTile label="Waarde B" value={formatEuro(kpis.stockValue.valueB)} />
            <SummaryTile
              label={`Verschil ${formatSignedPercentDisplay(kpis.stockValue.differencePercent)}`}
              value={formatSignedEuro(kpis.stockValue.differenceAmount)}
              tone={
                kpis.stockValue.differenceAmount > 0
                  ? "positive"
                  : kpis.stockValue.differenceAmount < 0
                    ? "negative"
                    : "neutral"
              }
            />
          </div>
        </div>

        <div className="summary-group">
          <p className="summary-group__label">Obsolete voorraad</p>
          <div className="summary-grid">
            <SummaryTile label="Waarde A" value={formatEuro(kpis.obsolete.valueA)} />
            <SummaryTile label="Waarde B" value={formatEuro(kpis.obsolete.valueB)} />
            <SummaryTile
              label="Verschil"
              value={formatSignedEuro(kpis.obsolete.differenceAmount)}
              tone={kpis.obsolete.differenceAmount > 0 ? "negative" : kpis.obsolete.differenceAmount < 0 ? "positive" : "neutral"}
            />
            <SummaryTile label="% van totaal A" value={`${kpis.obsolete.percentOfTotalA.toFixed(1)}%`} />
            <SummaryTile label="% van totaal B" value={`${kpis.obsolete.percentOfTotalB.toFixed(1)}%`} />
          </div>
        </div>

        <div className="summary-group">
          <p className="summary-group__label">Artikelen &amp; stockkwaliteit</p>
          <div className="summary-grid">
            <SummaryTile label="Artikelen A" value={kpis.articles.countA} />
            <SummaryTile label="Artikelen B" value={kpis.articles.countB} />
            <SummaryTile label="Verschil" value={formatSignedCount(kpis.articles.difference)} />
            <SummaryTile label="Normale voorraad A" value={formatEuro(kpis.quality.activeValueA)} />
            <SummaryTile label="Normale voorraad B" value={formatEuro(kpis.quality.activeValueB)} />
            <SummaryTile label="Obsolete voorraad A" value={formatEuro(kpis.quality.obsoleteValueA)} />
            <SummaryTile label="Obsolete voorraad B" value={formatEuro(kpis.quality.obsoleteValueB)} />
          </div>
        </div>
      </div>

      {/* Aandachtspunten (spec §13). */}
      {attentionPoints.length > 0 && (
        <div className="card stack stack--tight">
          <h2 style={{ margin: 0 }}>Aandachtspunten</h2>
          <div className="filter-row">
            {attentionPoints.map((point) => (
              <span key={point.kind} className="chip">
                {point.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Productgroepvergelijking (spec §5). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Vergelijking per productgroep</h2>
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Productgroep</th>
                <th>Artikelen A</th>
                <th>Artikelen B</th>
                <th>Waarde A</th>
                <th>Waarde B</th>
                <th>Verschil €</th>
                <th>Verschil %</th>
                <th>Obsolete A</th>
                <th>Obsolete B</th>
              </tr>
            </thead>
            <tbody>
              {productGroups.map((group) => (
                <tr key={group.productGroup}>
                  <td>
                    <button
                      type="button"
                      className="text-link-button"
                      onClick={() => onFilterProductGroup(group.productGroup)}
                    >
                      {group.productGroup}
                    </button>
                  </td>
                  <td>{group.articleCountA}</td>
                  <td>{group.articleCountB}</td>
                  <td>{formatEuro(group.valueA)}</td>
                  <td>{formatEuro(group.valueB)}</td>
                  <td>{formatSignedEuro(group.valueDifference)}</td>
                  <td>{formatSignedPercentDisplay(group.valueDifferencePercent)}</td>
                  <td>{formatEuro(group.obsoleteValueA)}</td>
                  <td>{formatEuro(group.obsoleteValueB)}</td>
                </tr>
              ))}
              {productGroups.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty-state">
                    Geen artikelen.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Grootste stijgingen en dalingen (spec §6). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Grootste stijgingen en dalingen</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Een waardeverschil kan door de hoeveelheid, de kostprijs, of beide veroorzaakt worden — "Oorzaak" geeft dit
          aan, zodat een verschil niet automatisch als fysieke voorraadbeweging geïnterpreteerd wordt.
        </p>
        <div>
          <h3 style={{ margin: 0 }}>Grootste stijgingen</h3>
          <MoverTable rows={movers.biggestIncreases} onOpenArticle={onOpenArticle} />
        </div>
        <div>
          <h3 style={{ margin: 0 }}>Grootste dalingen</h3>
          <MoverTable rows={movers.biggestDecreases} onOpenArticle={onOpenArticle} />
        </div>
      </div>

      {/* Ongewijzigde voorraad (spec §7). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Ongewijzigde voorraad</h2>
        <div className="summary-grid">
          <SummaryTile label="Aantal artikelen" value={unchanged.articleCount} />
          <SummaryTile label="Voorraadwaarde (B)" value={formatEuro(unchanged.totalStockValueB)} />
          <SummaryTile label="% van totale voorraadwaarde B" value={`${unchanged.percentOfTotalStockValueB.toFixed(1)}%`} />
        </div>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Een gelijke voorraad tussen twee tellingen bewijst niet dat er tussendoor geen ontvangst of verbruik was.
        </p>
        {unchanged.rows.length > 0 && (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Productgroep</th>
                  <th>Aantal A</th>
                  <th>Aantal B</th>
                  <th>Kostprijs A</th>
                  <th>Kostprijs B</th>
                  <th>Waarde B</th>
                  <th>Classificatie</th>
                </tr>
              </thead>
              <tbody>
                {unchanged.rows.slice(0, 50).map((row) => (
                  <tr key={row.articleId}>
                    <td>
                      <button type="button" className="text-link-button" onClick={() => onOpenArticle(row.articleId)}>
                        {row.articleNumber} — {row.description}
                      </button>
                    </td>
                    <td>{row.productGroup ?? "—"}</td>
                    <td>{formatCount(row.quantityA)}</td>
                    <td>{formatCount(row.quantityB)}</td>
                    <td>{formatEuro(row.costPriceA)}</td>
                    <td>{formatEuro(row.costPriceB)}</td>
                    <td>{formatEuro(row.stockValueB)}</td>
                    <td>{row.classificationB ? STOCK_CLASSIFICATION_LABELS[row.classificationB] : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unchanged.rows.length > 50 && (
              <p className="screen-subtitle" style={{ margin: 0 }}>
                {unchanged.rows.length - 50} bijkomende artikelen niet getoond — gebruik de volledige detailtabel
                onderaan (filter "Ongewijzigd") voor het complete overzicht.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Kandidaten voor obsolete-review (spec §9). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Kandidaten voor obsolete</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Dit zijn kandidaten voor beoordeling. Gelijke snapshots bewijzen niet dat het artikel tussendoor niet
          bewogen heeft.
        </p>
        {obsoleteCandidates.length === 0 ? (
          <p className="empty-state" style={{ margin: 0 }}>
            Geen kandidaten — geen enkel artikel is minstens {CONSECUTIVE_UNCHANGED_OBSOLETE_CANDIDATE_THRESHOLD}{" "}
            opeenvolgende betrouwbare tellingen ongewijzigd terwijl het nog als normale voorraad geclassificeerd
            staat.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Productgroep</th>
                  <th>Aantal</th>
                  <th>Voorraadwaarde</th>
                  <th>Opeenvolgend ongewijzigd</th>
                  <th>Sinds</th>
                  <th>Classificatie</th>
                  <th>Waarvan fysiek geteld</th>
                </tr>
              </thead>
              <tbody>
                {obsoleteCandidates.map((row) => (
                  <tr key={row.articleId}>
                    <td>
                      <button type="button" className="text-link-button" onClick={() => onOpenArticle(row.articleId)}>
                        {row.articleNumber} — {row.description}
                      </button>
                    </td>
                    <td>{row.productGroup ?? "—"}</td>
                    <td>{formatCount(row.quantityB)}</td>
                    <td>{formatEuro(row.stockValueB)}</td>
                    <td>{row.consecutiveUnchangedCount}</td>
                    <td>{row.consecutiveUnchangedSinceSessionName ?? "—"}</td>
                    <td>{row.classificationB ? STOCK_CLASSIFICATION_LABELS[row.classificationB] : "—"}</td>
                    <td>
                      {row.consecutiveUnchangedPhysicallyCountedCount} / {row.consecutiveUnchangedCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Obsolete vergelijking (spec §10). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Obsolete vergelijking</h2>
        <div className="stack">
          <ObsoleteTransitionList
            title="Nieuw obsolete (Normale voorraad → Obsolete)"
            rows={obsoleteTransitions.newObsolete}
            onOpenArticle={onOpenArticle}
          />
          <ObsoleteTransitionList
            title="Obsolete gebleven"
            rows={obsoleteTransitions.stayedObsolete}
            onOpenArticle={onOpenArticle}
          />
          <ObsoleteTransitionList
            title="Opnieuw actief (Obsolete → Normale voorraad)"
            rows={obsoleteTransitions.reactivated}
            onOpenArticle={onOpenArticle}
          />
        </div>
      </div>

      {/* Nieuwe/naar-nul/verdwenen artikelen (spec §11) — telling; volledige lijsten via de detailtabelfilters. */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Nieuwe, naar-nul en verdwenen artikelen</h2>
        <div className="filter-row">
          <button type="button" className="chip" onClick={() => onFilterState("NEW_ARTICLE")}>
            {transitionCounts.newArticles} nieuw artikel{transitionCounts.newArticles === 1 ? "" : "en"}
          </button>
          <span className="chip">
            {transitionCounts.fromZero} van 0 naar voorraad
          </span>
          <button type="button" className="chip" onClick={() => onFilterState("TO_ZERO")}>
            {transitionCounts.toZero} naar voorraad 0
          </button>
          <span className="chip">
            {transitionCounts.disappeared} niet meer aanwezig in B
          </span>
        </div>
        {transitionCounts.disappeared > 0 && (
          <p className="screen-subtitle" style={{ margin: 0 }}>
            "Niet meer aanwezig in B" mag niet automatisch als voorraad 0 geïnterpreteerd worden — het artikel
            ontbreekt volledig in de nieuwere telling.
          </p>
        )}
      </div>

      {/* Volledige detailtabel (spec §12). */}
      <div className="card stack" id={DETAIL_TABLE_ANCHOR_ID}>
        <h2 style={{ margin: 0 }}>Artikelen</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          {filteredArticles.length === articles.length
            ? `${articles.length} artikelen`
            : `${filteredArticles.length} van ${articles.length} artikelen`}
        </p>
        <div className="filter-row">
          <input
            className="search-input"
            placeholder="Zoeken op artikelnummer/omschrijving..."
            value={filters.search}
            onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
            style={{ flex: 1, minWidth: 200 }}
          />
          <select
            className="search-input"
            aria-label="Sorteren"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as ArticleComparisonSortMode)}
          >
            {(Object.keys(ARTICLE_COMPARISON_SORT_MODE_LABELS) as ArticleComparisonSortMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {ARTICLE_COMPARISON_SORT_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-row">
          <button
            type="button"
            className={`chip ${filters.state === "ALL" && filters.classification === null && filters.productGroup === null ? "chip--active" : ""}`}
            onClick={() => setFilters(DEFAULT_ARTICLE_COMPARISON_FILTERS)}
          >
            Alles
          </button>
          <button
            type="button"
            className={`chip ${filters.state === "CHANGED" ? "chip--active" : ""}`}
            onClick={() => onFilterState(filters.state === "CHANGED" ? "ALL" : "CHANGED")}
          >
            Gewijzigd
          </button>
          <button
            type="button"
            className={`chip ${filters.state === "UNCHANGED" ? "chip--active" : ""}`}
            onClick={() => onFilterState(filters.state === "UNCHANGED" ? "ALL" : "UNCHANGED")}
          >
            Ongewijzigd
          </button>
          <button
            type="button"
            className={`chip ${filters.state === "OBSOLETE_CANDIDATE" ? "chip--active" : ""}`}
            onClick={() => onFilterState(filters.state === "OBSOLETE_CANDIDATE" ? "ALL" : "OBSOLETE_CANDIDATE")}
          >
            Kandidaat obsolete
          </button>
          <button
            type="button"
            className={`chip ${filters.state === "NEW_ARTICLE" ? "chip--active" : ""}`}
            onClick={() => onFilterState(filters.state === "NEW_ARTICLE" ? "ALL" : "NEW_ARTICLE")}
          >
            Nieuw artikel
          </button>
          <button
            type="button"
            className={`chip ${filters.state === "TO_ZERO" ? "chip--active" : ""}`}
            onClick={() => onFilterState(filters.state === "TO_ZERO" ? "ALL" : "TO_ZERO")}
          >
            Naar voorraad 0
          </button>
          <button
            type="button"
            className={`chip ${filters.state === "NEW_OBSOLETE" ? "chip--active" : ""}`}
            onClick={() => onFilterState(filters.state === "NEW_OBSOLETE" ? "ALL" : "NEW_OBSOLETE")}
          >
            Nieuw obsolete
          </button>
          {(Object.keys(STOCK_CLASSIFICATION_LABELS) as StockClassification[]).map((classification) => (
            <button
              key={classification}
              type="button"
              className={`chip ${filters.classification === classification ? "chip--active" : ""}`}
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  classification: prev.classification === classification ? null : classification,
                }))
              }
            >
              {STOCK_CLASSIFICATION_LABELS[classification]} (B)
            </button>
          ))}
          {filters.productGroup !== null && (
            <span className="chip chip--active location-chip">
              <span>Productgroep: {filters.productGroup}</span>
              <button
                type="button"
                className="location-chip__remove"
                aria-label="Productgroepfilter wissen"
                onClick={() => setFilters((prev) => ({ ...prev, productGroup: null }))}
              >
                ×
              </button>
            </span>
          )}
        </div>
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Artikel</th>
                <th>Productgroep</th>
                <th>Classificatie A</th>
                <th>Classificatie B</th>
                <th>Aantal A</th>
                <th>Aantal B</th>
                <th>Verschil</th>
                <th>Kostprijs A</th>
                <th>Kostprijs B</th>
                <th>Waarde A</th>
                <th>Waarde B</th>
                <th>€ verschil</th>
              </tr>
            </thead>
            <tbody>
              {filteredArticles.map((row) => (
                <tr key={row.articleId}>
                  <td>
                    <button type="button" className="text-link-button" onClick={() => onOpenArticle(row.articleId)}>
                      {row.articleNumber} — {row.description}
                    </button>
                  </td>
                  <td>{row.productGroup ?? "—"}</td>
                  <td>{row.classificationA ? STOCK_CLASSIFICATION_LABELS[row.classificationA] : "—"}</td>
                  <td>{row.classificationB ? STOCK_CLASSIFICATION_LABELS[row.classificationB] : "—"}</td>
                  <td>{row.presentInA ? formatCount(row.quantityA) : "—"}</td>
                  <td>{row.presentInB ? formatCount(row.quantityB) : "—"}</td>
                  <td>{formatSignedCount(row.quantityDifference)}</td>
                  <td>{formatEuro(row.costPriceA)}</td>
                  <td>{formatEuro(row.costPriceB)}</td>
                  <td>{row.presentInA ? formatEuro(row.stockValueA) : "—"}</td>
                  <td>{row.presentInB ? formatEuro(row.stockValueB) : "—"}</td>
                  <td>{formatSignedEuro(row.valueDifference)}</td>
                </tr>
              ))}
              {filteredArticles.length === 0 && (
                <tr>
                  <td colSpan={12} className="empty-state">
                    Geen artikelen voor dit filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MoverTable({ rows, onOpenArticle }: { rows: MoverRow[]; onOpenArticle: (articleId: string) => void }) {
  if (rows.length === 0) {
    return <p className="empty-state">Geen artikelen.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="history-table">
        <thead>
          <tr>
            <th>Artikel</th>
            <th>Productgroep</th>
            <th>Aantal A</th>
            <th>Aantal B</th>
            <th>Kostprijs A</th>
            <th>Kostprijs B</th>
            <th>Waarde A</th>
            <th>Waarde B</th>
            <th>€ verschil</th>
            <th>Oorzaak</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.articleId}>
              <td>
                <button type="button" className="text-link-button" onClick={() => onOpenArticle(row.articleId)}>
                  {row.articleNumber} — {row.description}
                </button>
              </td>
              <td>{row.productGroup ?? "—"}</td>
              <td>{formatCount(row.quantityA)}</td>
              <td>{formatCount(row.quantityB)}</td>
              <td>{formatEuro(row.costPriceA)}</td>
              <td>{formatEuro(row.costPriceB)}</td>
              <td>{formatEuro(row.stockValueA)}</td>
              <td>{formatEuro(row.stockValueB)}</td>
              <td>{formatSignedEuro(row.valueDifference)}</td>
              <td>{DRIVER_LABELS[row.driver]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObsoleteTransitionList({
  title,
  rows,
  onOpenArticle,
}: {
  title: string;
  rows: ArticleComparisonRow[];
  onOpenArticle: (articleId: string) => void;
}) {
  return (
    <div>
      <h3 style={{ margin: 0 }}>
        {title} ({rows.length})
      </h3>
      {rows.length === 0 ? (
        <p className="empty-state">Geen artikelen.</p>
      ) : (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Artikel</th>
                <th>Productgroep</th>
                <th>Aantal B</th>
                <th>Voorraadwaarde B</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.articleId}>
                  <td>
                    <button type="button" className="text-link-button" onClick={() => onOpenArticle(row.articleId)}>
                      {row.articleNumber} — {row.description}
                    </button>
                  </td>
                  <td>{row.productGroup ?? "—"}</td>
                  <td>{formatCount(row.quantityB)}</td>
                  <td>{formatEuro(row.stockValueB)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
