import { useState } from "react";
import { activeLocationsInOrder } from "../../domain/locations";
import { countingRepository } from "../../application/container";
import { BigButton } from "../components/BigButton";
import { SimpleLineChart } from "../components/SimpleLineChart";
import { formatSignedCount } from "../../shared/format";
import {
  useArticleHistory,
  useArticles,
  useAssignments,
  useOffice,
} from "../hooks/useLiveData";

interface ArticleDetailPageProps {
  officeId: string;
  articleId: string;
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Actief",
  INACTIVE: "Inactief",
};

/**
 * Artikeldetailpagina (spec v0.2.1 §6-8): een echte beheerplek voor één
 * artikel — Algemeen, Locaties (toevoegen/verwijderen), evolutie/historiek
 * en een eenvoudige grafiek. Bewust geen wizard: elke actie hier past het
 * domeinmodel meteen aan (via de repository/ArticleLocationAssignment),
 * zonder apart opslaan-moment.
 */
export function ArticleDetailPage({ officeId, articleId }: ArticleDetailPageProps) {
  const articles = useArticles(officeId) ?? [];
  const office = useOffice(officeId);
  const assignments = useAssignments(officeId) ?? [];
  const history = useArticleHistory(officeId, articleId) ?? [];

  const [addingLocationId, setAddingLocationId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const article = articles.find((a) => a.id === articleId);

  if (!article || !office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  const locationById = new Map(office.locations.map((l) => [l.id, l]));
  const activeAssignments = assignments.filter((a) => a.active && a.articleId === articleId);
  const assignedLocationIds = new Set(activeAssignments.map((a) => a.locationId));
  const availableLocationsToAdd = activeLocationsInOrder(office).filter(
    (l) => !assignedLocationIds.has(l.id),
  );

  async function saveAssignment(locationId: string, active: boolean) {
    setError(null);
    try {
      await countingRepository.saveArticleLocationAssignment({
        id: `${officeId}:${articleId}:${locationId}`,
        officeId,
        articleId,
        locationId,
        active,
        lastSeenAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  }

  async function handleAddLocation() {
    if (!addingLocationId) return;
    await saveAssignment(addingLocationId, true);
    setAddingLocationId("");
  }

  const chartPoints = history.map((point) => ({
    label: new Date(point.date).toLocaleDateString("nl-BE", { day: "2-digit", month: "2-digit" }),
    value: point.totalCount,
  }));

  return (
    <div className="stack">
      <h1 className="screen-title">{article.description || "(geen omschrijving)"}</h1>
      <p className="screen-subtitle">{article.articleNumber}</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="card stack stack--tight">
        <h2 style={{ margin: 0 }}>Algemeen</h2>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Artikelnummer</span>
          <span className="article-detail-field__value">{article.articleNumber}</span>
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Omschrijving</span>
          <span className="article-detail-field__value">{article.description || "—"}</span>
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Productgroep</span>
          <span className="article-detail-field__value">{article.productGroup ?? "—"}</span>
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Leverancier</span>
          <span className="article-detail-field__value">{article.supplier ?? "—"}</span>
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Eenheid</span>
          <span className="article-detail-field__value">{article.unit ?? "—"}</span>
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Telperiode</span>
          <span className="article-detail-field__value">{article.rawCountPeriod ?? "—"}</span>
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Status</span>
          <span className="article-detail-field__value">{STATUS_LABELS[article.status] ?? article.status}</span>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Locaties</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Verwachte stocklocaties voor dit artikel. Een artikel mag op meerdere locaties liggen.
        </p>
        <div className="stack stack--tight">
          {activeAssignments.length === 0 && (
            <p className="empty-state">Nog geen vaste locatie gekoppeld aan dit artikel.</p>
          )}
          {activeAssignments.map((assignment) => (
            <div key={assignment.locationId} className="filter-row" style={{ justifyContent: "space-between" }}>
              <span className="chip chip--active">{locationById.get(assignment.locationId)?.name ?? assignment.locationId}</span>
              <button type="button" className="chip" onClick={() => saveAssignment(assignment.locationId, false)}>
                Verwijderen
              </button>
            </div>
          ))}
        </div>

        {availableLocationsToAdd.length > 0 && (
          <div className="stack stack--tight" style={{ flexDirection: "row" }}>
            <select
              className="search-input"
              style={{ flex: 1 }}
              value={addingLocationId}
              onChange={(e) => setAddingLocationId(e.target.value)}
            >
              <option value="">Kies een locatie...</option>
              {availableLocationsToAdd.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <BigButton variant="secondary" style={{ width: "auto" }} onClick={handleAddLocation}>
              + Toevoegen
            </BigButton>
          </div>
        )}
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Voorraad doorheen de tijd</h2>
        <SimpleLineChart points={chartPoints} />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Historiek</h2>
        {history.length === 0 ? (
          <p className="empty-state">Nog geen afgeronde tellingen voor dit artikel.</p>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>Teldatum</th>
                <th>Totale voorraad</th>
                <th>Verschil</th>
                <th>Locaties</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().map((point) => (
                <tr key={point.sessionId}>
                  <td>{new Date(point.date).toLocaleDateString("nl-BE")}</td>
                  <td>{point.totalCount}</td>
                  <td>{formatSignedCount(point.difference)}</td>
                  <td>{point.locationNames.length > 0 ? point.locationNames.join(", ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
