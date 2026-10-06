import { useEffect, useMemo, useState } from "react";
import { legacySnapshotService } from "../../application/container";
import type { LegacySnapshotDetail } from "../../application/services/LegacySnapshotService";
import { BigButton } from "../components/BigButton";
import { SummaryTile } from "../components/SummaryTile";
import { formatCount, formatEuro } from "../../shared/format";

interface LegacySnapshotPageProps {
  officeId: string;
  /** `legacy:<periodKey>` */
  snapshotId: string;
  /** Naar "Vergelijken" met deze snapshot als telling B. */
  onOpenComparison: (snapshotId: string) => void;
}

const MAX_VISIBLE_ARTICLES = 150;

/**
 * Alleen-lezen detail van een legacy "Historische snapshot" (Home → Vorige
 * tellingen). Toont uitsluitend de bevroren historische hoeveelheden/
 * kostprijzen van die periode (zie `domain/legacySnapshotView.ts`); er is
 * geen enkele schrijfactie. Export gaat via `legacySnapshotService`, los van
 * het rollend archief.
 */
export function LegacySnapshotPage({ officeId, snapshotId, onOpenComparison }: LegacySnapshotPageProps) {
  const [detail, setDetail] = useState<LegacySnapshotDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    legacySnapshotService
      .getDetail(officeId, snapshotId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Onbekende fout bij het laden van de snapshot.");
      });
    return () => {
      cancelled = true;
    };
  }, [officeId, snapshotId]);

  const filtered = useMemo(() => {
    if (!detail) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return detail.view.articles;
    return detail.view.articles.filter(
      (a) =>
        a.articleNumber.toLowerCase().includes(needle) ||
        a.description.toLowerCase().includes(needle) ||
        a.productCategory.toLowerCase().includes(needle),
    );
  }, [detail, search]);

  async function handleExport() {
    setExportError(null);
    setExporting(true);
    try {
      const file = await legacySnapshotService.exportToExcel(officeId, snapshotId);
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
      setExportError(err instanceof Error ? err.message : "Onbekende fout bij het exporteren.");
    } finally {
      setExporting(false);
    }
  }

  if (loadError) return <div className="error-banner">{loadError}</div>;
  if (!detail) return <p className="screen-subtitle">Bezig met laden...</p>;

  const { view } = detail;
  const visible = showAll || search.trim() ? filtered : filtered.slice(0, MAX_VISIBLE_ARTICLES);

  return (
    <div className="stack analysis-page legacy-snapshot-page">
      <h1 className="screen-title">
        {detail.title}
        <span className="readonly-badge">Alleen-lezen</span>
      </h1>
      <p className="screen-subtitle">
        {detail.officeName} · historische peildatum {view.periodLabel}
      </p>

      <div className="mode-toggle">
        <span className="mode-toggle__button mode-toggle__button--active">Analyse</span>
        <button type="button" className="mode-toggle__button" onClick={() => onOpenComparison(snapshotId)}>
          Vergelijken
        </button>
      </div>

      <div className="stack stack--tight">
        <BigButton variant="secondary" disabled={exporting} onClick={handleExport}>
          {exporting ? "Bezig met exporteren..." : "Exporteren naar Excel"}
        </BigButton>
        {exportError && <div className="error-banner">{exportError}</div>}
      </div>

      <div className="summary-grid">
        <SummaryTile label="Totale voorraadwaarde" value={formatEuro(view.totalStockValue)} />
        <SummaryTile label="Artikels" value={formatCount(view.articleCount)} />
        <SummaryTile label="Productgamma's" value={formatCount(view.categories.length)} />
      </div>
      {view.articlesWithUnknownValue > 0 && (
        <p className="screen-subtitle">
          {view.articlesWithUnknownValue} artikel(s) zonder gekende hoeveelheid of kostprijs tellen niet mee in de waarde.
        </p>
      )}
      <p className="screen-subtitle">
        Hoeveelheden en kostprijzen zijn de originele historische waarden van deze periode.
      </p>

      <h2 className="screen-subtitle" style={{ fontWeight: 700 }}>
        Productgamma&apos;s
      </h2>
      <div className="stack stack--tight">
        {view.categories.map((c) => (
          <div key={c.categoryName} className="session-history-item" style={{ cursor: "default" }}>
            <span>
              {c.categoryName}
              <span className="screen-subtitle" style={{ margin: 0 }}>
                {" "}
                · {formatCount(c.articleCount)} artikels
              </span>
            </span>
            <span>{formatEuro(c.stockValue)}</span>
          </div>
        ))}
      </div>

      <h2 className="screen-subtitle" style={{ fontWeight: 700 }}>
        Artikels
      </h2>
      <input
        className="search-input"
        type="search"
        placeholder="Zoek op nummer, omschrijving of productgamma"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Zoek artikels"
      />
      <div className="stack stack--tight">
        {visible.map((a) => (
          <div key={a.articleId} className="session-history-item" style={{ cursor: "default" }}>
            <span className="stack stack--tight" style={{ gap: 2 }}>
              <span>
                {a.articleNumber} — {a.description}
              </span>
              <span className="screen-subtitle" style={{ margin: 0 }}>
                {a.productCategory} · {a.quantity === null ? "?" : formatCount(a.quantity)} ×{" "}
                {a.costPrice === null ? "?" : formatEuro(a.costPrice)}
              </span>
            </span>
            <span>{a.value === null ? "—" : formatEuro(a.value)}</span>
          </div>
        ))}
      </div>
      {!showAll && !search.trim() && filtered.length > MAX_VISIBLE_ARTICLES && (
        <BigButton variant="ghost" onClick={() => setShowAll(true)}>
          Toon alle {filtered.length} artikels
        </BigButton>
      )}
    </div>
  );
}
