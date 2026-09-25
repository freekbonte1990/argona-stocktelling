import { useEffect, useMemo, useState } from "react";
import {
  ANALYSIS_ARTICLE_SORT_MODE_LABELS,
  DEFAULT_ANALYSIS_ARTICLE_FILTERS,
  filterAnalysisArticles,
  sortAnalysisArticles,
  type AnalysisArticleFilters,
  type AnalysisArticleSortMode,
  type SessionAnalysis,
} from "../../domain/analysis";
import { STOCK_CLASSIFICATION_LABELS } from "../../domain/stockClassification";
import type { StockClassification } from "../../domain/types";
import { analysisService } from "../../application/container";
import { SessionNotAnalyzableError } from "../../application/services/AnalysisService";
import { SummaryTile } from "../components/SummaryTile";
import { useOffice, useSession } from "../hooks/useLiveData";
import { SESSION_TYPE_LABELS } from "../sessionTypeLabels";
import { formatCount, formatDate, formatEuro, formatSignedCount, formatSignedEuro } from "../../shared/format";

interface AnalysisPageProps {
  sessionId: string;
  /** Naar de artikeldetailpagina (spec §6/§11: "opent het bestaande artikeldetail/historiek"). */
  onOpenArticle: (articleId: string) => void;
}

const ARTICLE_LIST_ANCHOR_ID = "analysis-article-list";

/**
 * "Analyse telling" (Sprint 2 — Historical Count Analysis): een strikt
 * alleen-lezen view voor een AFGERONDE (COMPLETED) sessie. In tegenstelling
 * tot `ReviewPage` (die de review altijd LIVE herberekent uit de huidige
 * artikelstam, ook voor een reeds afgeronde sessie) haalt dit scherm het
 * reeds BEVROREN resultaat op via `AnalysisService` — zie spec §1/§13 en
 * `docs/ARCHITECTURE.md`. Een latere kostprijs-/productgroep-/
 * classificatiewijziging op het artikeldetailscherm kan deze cijfers dus
 * nooit meer beïnvloeden.
 *
 * Geen enkele telactie (tellen/bevestigen/afronden/exporteren) staat op dit
 * scherm — dat blijft allemaal bij `ReviewPage`, dat de LOPENDE (ACTIVE)
 * sessie bedient.
 */
export function AnalysisPage({ sessionId, onOpenArticle }: AnalysisPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);

  const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    analysisService
      .getSessionAnalysis(sessionId)
      .then((result) => {
        if (!cancelled) setAnalysis(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setAnalysis(null);
        setLoadError(
          err instanceof SessionNotAnalyzableError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Onbekende fout bij het laden van de analyse.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const [filters, setFilters] = useState<AnalysisArticleFilters>(DEFAULT_ANALYSIS_ARTICLE_FILTERS);
  const [sortMode, setSortMode] = useState<AnalysisArticleSortMode>("GROUP_THEN_DESCRIPTION");
  const [showAllNegative, setShowAllNegative] = useState(false);
  const [showAllPositive, setShowAllPositive] = useState(false);

  const filteredArticles = useMemo(
    () => (analysis ? sortAnalysisArticles(filterAnalysisArticles(analysis.articles, filters), sortMode) : []),
    [analysis, filters, sortMode],
  );

  // BELANGRIJK: `session`/`office` komen uit reactieve `useLiveQuery`-hooks
  // (Dexie) die ONAFHANKELIJK van `analysisService.getSessionAnalysis` laden
  // — hun eerste render is altijd `undefined`, ook nadat de analyse-fetch
  // al is afgerond. Als we dat als een fout zouden behandelen, zou dit
  // scherm bij elke opening héél even (race condition) de foutmelding tonen
  // in plaats van de laadindicator. Omdat `getSessionAnalysis` zelf al
  // bewijst dat de sessie/het kantoor bestaan zodra `analysis` gevuld is,
  // is dit gewoon nog even wachten op diezelfde data via het andere kanaal
  // — geen echte fout — dus blijven we de laadindicator tonen totdat ze
  // allebei zijn bijgetrokken.
  if (loading) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }
  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }
  if (!analysis || !session || !office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  function scrollToArticleList() {
    document.getElementById(ARTICLE_LIST_ANCHOR_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function applyFilter(next: Partial<AnalysisArticleFilters>, sort?: AnalysisArticleSortMode) {
    setFilters({ ...DEFAULT_ANALYSIS_ARTICLE_FILTERS, ...next });
    if (sort) setSortMode(sort);
    scrollToArticleList();
  }
  function filterByProductGroup(group: string) {
    applyFilter({ productGroup: group });
  }
  function filterByClassification(classification: StockClassification) {
    applyFilter({ classification }, "STOCK_VALUE_DESC");
  }
  function filterByDifference() {
    applyFilter({ onlyWithDifference: true }, "CORRECTION_AMOUNT_DESC");
  }
  function filterByNotCounted() {
    applyFilter({ countingState: "CARRIED_OVER" });
  }

  const { header, kpis, productGroups, obsolete, countingQuality, deviations, locations, attentionPoints } =
    analysis;

  return (
    <div className="stack analysis-page">
      <h1 className="screen-title">
        {header.sessionName}
        <span className="readonly-badge">Alleen-lezen</span>
      </h1>
      <p className="screen-subtitle">
        {office.name}
        {" · "}
        {SESSION_TYPE_LABELS[header.sessionType] ?? header.sessionType}
        {session.completedAt ? ` · afgerond op ${formatDate(session.completedAt)}` : ""}
      </p>

      {/* KPI's (spec §2). Visuele-verduidelijkingsronde: drie kern-cijfers
          (totale voorraadwaarde, fysiek geteld, netto correctie) krijgen een
          dominante "hero"-tegel, de rest staat in kleinere, expliciet
          benoemde ondersteunende groepen — puur presentationeel, geen enkele
          berekening hieronder wijkt af van `kpis`/`obsolete`. */}
      <div className="stack stack--tight review-summary">
        <div className="summary-group">
          <div className="summary-grid summary-grid--hero">
            <SummaryTile label="Totale voorraadwaarde" value={formatEuro(kpis.totalStockValue)} />
            <SummaryTile label="Fysiek geteld" value={kpis.physicallyCountedArticles} />
            <SummaryTile
              label="Netto correctie (€)"
              value={formatSignedEuro(kpis.netCorrectionAmount)}
              tone={kpis.netCorrectionAmount > 0 ? "positive" : kpis.netCorrectionAmount < 0 ? "negative" : "neutral"}
            />
          </div>
        </div>

        <div className="summary-group">
          <p className="summary-group__label">Omvang van de telling</p>
          <p className="screen-subtitle summary-group__hint">
            "Artikelen in scope" moesten deze sessie geteld worden. "Overgenomen (buiten scope)" hoorde nooit bij
            deze telling (bv. een kwartaalartikel tijdens een maandtelling) en behoudt gewoon zijn vorige waarde —
            die waarde zit wel in de totale voorraadwaarde hierboven. "Overgenomen — niet geteld (in scope)" hoorde
            wél bij deze telling, maar werd niet fysiek geteld bij het afronden.
          </p>
          <div className="summary-grid">
            <SummaryTile label="Artikelen in scope" value={kpis.articlesInScope} />
            <SummaryTile label="0 bevestigd" value={kpis.confirmedZeroArticles} />
            <SummaryTile label="Overgenomen (buiten scope)" value={kpis.carriedOverArticles} />
            <SummaryTile label="Overgenomen — niet geteld (in scope)" value={kpis.carriedOverNotCountedArticles} />
          </div>
        </div>

        <div className="summary-group summary-group--financial">
          <p className="summary-group__label">Financiële correctie</p>
          <div className="summary-grid">
            <SummaryTile label="Met verschil" value={kpis.articlesWithDifference} />
            <SummaryTile label="Correctie + (€)" value={formatEuro(kpis.positiveCorrectionAmount)} tone="positive" />
            <SummaryTile label="Correctie - (€)" value={formatEuro(kpis.negativeCorrectionAmount)} tone="negative" />
          </div>
        </div>
      </div>

      {/* Aandachtspunten (spec §10) — regelgebaseerd, geen AI. */}
      {attentionPoints.length > 0 && (
        <div className="card stack stack--tight">
          <h2 style={{ margin: 0 }}>Aandachtspunten</h2>
          <div className="filter-row">
            {attentionPoints.map((point) => {
              const onClick =
                point.kind === "NOT_COUNTED"
                  ? filterByNotCounted
                  : point.kind === "BIG_DEVIATION"
                    ? filterByDifference
                    : point.kind === "OBSOLETE_VALUE"
                      ? () => filterByClassification("OBSOLETE")
                      : undefined;
              return (
                <button
                  key={point.kind}
                  type="button"
                  className="chip"
                  disabled={!onClick}
                  onClick={onClick}
                >
                  {point.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Voorraadwaarde per productgroep (spec §4). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Voorraadwaarde per productgroep</h2>
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Productgroep</th>
                <th>Artikelen</th>
                <th>Stuks</th>
                <th>Voorraadwaarde</th>
                <th>Correctie +</th>
                <th>Correctie -</th>
                <th>Netto</th>
                <th>% van totaal</th>
              </tr>
            </thead>
            <tbody>
              {productGroups.map((group) => (
                <tr key={group.productGroup}>
                  <td>
                    <button type="button" className="text-link-button" onClick={() => filterByProductGroup(group.productGroup)}>
                      {group.productGroup}
                    </button>
                  </td>
                  <td>{group.articleCount}</td>
                  <td>{formatCount(group.totalUnits)}</td>
                  <td>{formatEuro(group.stockValue)}</td>
                  <td>{formatEuro(group.positiveCorrectionAmount)}</td>
                  <td>{formatEuro(group.negativeCorrectionAmount)}</td>
                  <td>{formatSignedEuro(group.netCorrectionAmount)}</td>
                  <td>{group.percentOfTotalStockValue.toFixed(1)}%</td>
                </tr>
              ))}
              {productGroups.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-state">
                    Geen artikelen.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Obsolete stock (spec §5-6). Als alle waarden nul zijn (geen enkel
          artikel is als "Obsolete" geclassificeerd) toont dit blok bewust
          één compacte regel i.p.v. vier lege KPI-tegels + twee lege
          tabellen — de cijfers/berekening zelf blijven ongewijzigd. */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Obsolete voorraad</h2>
        {obsolete.obsoleteArticleCount === 0 ? (
          <p className="empty-state" style={{ margin: 0 }}>
            Geen artikelen met classificatie "Obsolete" in deze telling — € 0,00 obsolete voorraad.
          </p>
        ) : (
          <>
            <div className="summary-grid">
              <SummaryTile label="Obsolete waarde" value={formatEuro(obsolete.totalObsoleteValue)} tone="negative" />
              <SummaryTile
                label="% van totale voorraadwaarde"
                value={`${obsolete.percentOfTotalStockValue.toFixed(1)}%`}
              />
              <SummaryTile label="Aantal artikelen" value={obsolete.obsoleteArticleCount} />
              <SummaryTile label="Aantal stuks" value={formatCount(obsolete.obsoleteTotalUnits)} />
            </div>
            {obsolete.byProductGroup.length > 0 && (
              <div className="table-scroll">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Productgroep</th>
                      <th>Artikelen</th>
                      <th>Stuks</th>
                      <th>Obsolete waarde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {obsolete.byProductGroup.map((row) => (
                      <tr key={row.productGroup}>
                        <td>{row.productGroup}</td>
                        <td>{row.articleCount}</td>
                        <td>{formatCount(row.totalUnits)}</td>
                        <td>{formatEuro(row.obsoleteValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="table-scroll">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Artikel</th>
                    <th>Productgroep</th>
                    <th>Aantal</th>
                    <th>Kostprijs</th>
                    <th>Totale waarde</th>
                  </tr>
                </thead>
                <tbody>
                  {obsolete.articles.map((article) => (
                    <tr key={article.articleId}>
                      <td>
                        <button
                          type="button"
                          className="text-link-button"
                          onClick={() => onOpenArticle(article.articleId)}
                        >
                          {article.articleNumber} — {article.description}
                        </button>
                      </td>
                      <td>{article.productGroup ?? "—"}</td>
                      <td>{formatCount(article.quantity)}</td>
                      <td>{formatEuro(article.costPrice)}</td>
                      <td>{formatEuro(article.stockValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Telkwaliteit/volledigheid (spec §7). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Telkwaliteit</h2>
        <div className="summary-grid">
          <SummaryTile label="Fysiek geteld" value={countingQuality.physicallyCountedArticles} />
          <SummaryTile label="0 bevestigd" value={countingQuality.confirmedZeroArticles} />
          <SummaryTile label="Overgenomen" value={countingQuality.carriedOverArticles} />
          <SummaryTile label="Overgenomen — niet geteld" value={countingQuality.carriedOverNotCountedArticles} />
          <SummaryTile label="% fysiek opgelost" value={`${countingQuality.percentPhysicallyResolved.toFixed(1)}%`} />
          <SummaryTile label="Nieuwe artikelen gevonden" value={countingQuality.newArticlesFound} />
        </div>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          "Onverwachte locaties gevonden" wordt hier bewust niet getoond: de bevroren tellingdata van deze
          sessie bevat geen betrouwbaar onderscheid tussen een telling op een toen al verwachte locatie en
          een telling op een toen nog onverwachte locatie.
        </p>
      </div>

      {/* Grootste afwijkingen (spec §8). */}
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Grootste afwijkingen</h2>
        <div className="stack">
          <div>
            <h3 style={{ margin: 0 }}>Grootste negatieve afwijkingen</h3>
            <DeviationTable
              rows={showAllNegative ? deviations.all.filter((d) => d.correctionAmount < 0) : deviations.biggestNegative}
              onOpenArticle={onOpenArticle}
            />
            {deviations.all.some((d) => d.correctionAmount < 0) && (
              <button type="button" className="text-link-button" onClick={() => setShowAllNegative((v) => !v)}>
                {showAllNegative ? "Toon minder" : "Alle negatieve afwijkingen tonen"}
              </button>
            )}
          </div>
          <div>
            <h3 style={{ margin: 0 }}>Grootste positieve afwijkingen</h3>
            <DeviationTable
              rows={showAllPositive ? deviations.all.filter((d) => d.correctionAmount > 0) : deviations.biggestPositive}
              onOpenArticle={onOpenArticle}
            />
            {deviations.all.some((d) => d.correctionAmount > 0) && (
              <button type="button" className="text-link-button" onClick={() => setShowAllPositive((v) => !v)}>
                {showAllPositive ? "Toon minder" : "Alle positieve afwijkingen tonen"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Analyse per locatie (spec §9). */}
      {locations.length > 0 && (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Analyse per locatie</h2>
          <p className="screen-subtitle" style={{ margin: 0 }}>
            Correctie-€ per locatie wordt hier bewust niet getoond: "vorige telling" is enkel op artikelniveau
            bevroren, nooit per locatie — een artikel op meerdere locaties zou anders dubbel meetellen.
          </p>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Locatie</th>
                  <th>Fysiek geteld</th>
                  <th>Met verschil</th>
                  <th>Stuks geteld</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((location) => (
                  <tr key={location.locationId}>
                    <td>{location.locationName}</td>
                    <td>{location.physicallyCountedArticles}</td>
                    <td>{location.articlesWithDifference}</td>
                    <td>{formatCount(location.totalUnitsCounted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detaillijst (spec §11). */}
      <div className="card stack" id={ARTICLE_LIST_ANCHOR_ID}>
        <h2 style={{ margin: 0 }}>Artikelen</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          {filteredArticles.length === analysis.articles.length
            ? `${analysis.articles.length} artikelen`
            : `${filteredArticles.length} van ${analysis.articles.length} artikelen`}
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
            onChange={(e) => setSortMode(e.target.value as AnalysisArticleSortMode)}
          >
            {(Object.keys(ANALYSIS_ARTICLE_SORT_MODE_LABELS) as AnalysisArticleSortMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {ANALYSIS_ARTICLE_SORT_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-row">
          <button
            type="button"
            className={`chip ${filters.classification === null && filters.countingState === "ALL" && !filters.onlyWithDifference && filters.productGroup === null ? "chip--active" : ""}`}
            onClick={() => setFilters(DEFAULT_ANALYSIS_ARTICLE_FILTERS)}
          >
            Alles
          </button>
          <button
            type="button"
            className={`chip ${filters.onlyWithDifference ? "chip--active" : ""}`}
            onClick={() => setFilters((prev) => ({ ...prev, onlyWithDifference: !prev.onlyWithDifference }))}
          >
            Met verschil
          </button>
          <button
            type="button"
            className={`chip ${filters.countingState === "PHYSICALLY_COUNTED" ? "chip--active" : ""}`}
            onClick={() =>
              setFilters((prev) => ({
                ...prev,
                countingState: prev.countingState === "PHYSICALLY_COUNTED" ? "ALL" : "PHYSICALLY_COUNTED",
              }))
            }
          >
            Fysiek geteld
          </button>
          <button
            type="button"
            className={`chip ${filters.countingState === "CARRIED_OVER" ? "chip--active" : ""}`}
            onClick={() =>
              setFilters((prev) => ({
                ...prev,
                countingState: prev.countingState === "CARRIED_OVER" ? "ALL" : "CARRIED_OVER",
              }))
            }
          >
            Overgenomen
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
              {STOCK_CLASSIFICATION_LABELS[classification]}
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
                <th>Classificatie</th>
                <th>Vorige telling</th>
                <th>Eindsnapshot</th>
                <th>Verschil</th>
                <th>Kostprijs</th>
                <th>Voorraadwaarde</th>
                <th>Correctie €</th>
                <th>Status</th>
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
                  <td>{STOCK_CLASSIFICATION_LABELS[row.classification]}</td>
                  <td>{formatCount(row.previousCount)}</td>
                  <td>{formatCount(row.finalQuantity)}</td>
                  <td>{formatSignedCount(row.differenceQuantity)}</td>
                  <td>{formatEuro(row.costPrice)}</td>
                  <td>{formatEuro(row.stockValue)}</td>
                  <td>{formatSignedEuro(row.correctionAmount)}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
              {filteredArticles.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty-state">
                    Geen artikelen voor dit filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DeviationTable({
  rows,
  onOpenArticle,
}: {
  rows: SessionAnalysis["deviations"]["all"];
  onOpenArticle: (articleId: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="empty-state">Geen afwijkingen.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="history-table">
        <thead>
          <tr>
            <th>Artikel</th>
            <th>Vorige telling</th>
            <th>Nieuwe telling</th>
            <th>Verschil</th>
            <th>€ impact</th>
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
              <td>{formatCount(row.previousCount)}</td>
              <td>{formatCount(row.finalQuantity)}</td>
              <td>{formatSignedCount(row.differenceQuantity)}</td>
              <td>{formatSignedEuro(row.correctionAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
