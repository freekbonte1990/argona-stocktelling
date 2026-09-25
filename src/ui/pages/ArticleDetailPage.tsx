import { useState } from "react";
import { activeLocationsInOrder } from "../../domain/locations";
import { ARTICLE_STATUS_OPTIONS, FREQUENCY_TO_RAW } from "../../domain/frequency";
import { FREQUENCY_FILTER_LABELS } from "../../domain/articleListing";
import { getStockClassification, STOCK_CLASSIFICATION_LABELS } from "../../domain/stockClassification";
import type { ArticleCountFrequency, StockClassification } from "../../domain/types";
import { countingRepository } from "../../application/container";
import { BigButton } from "../components/BigButton";
import { SimpleLineChart } from "../components/SimpleLineChart";
import type { SimpleLineChartPoint } from "../components/SimpleLineChart";
import type { MergedArticleHistoryPoint } from "../../domain/articleHistory";
import { formatDate, formatEuro, formatSignedCount, formatSignedEuro } from "../../shared/format";
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

/**
 * Zoekt de `ARTICLE_STATUS_OPTIONS`-optie die bij een artikel hoort — op
 * basis van `rawStatus` (case-insensitief/getrimd, want dat kan uit een
 * oudere Excel-import komen met net iets andere spelling/hoofdletters dan
 * onze eigen 4 canonieke waarden). Vindt niets (bv. een ANDERE, hier nog
 * onbekende vrije-tekstwaarde uit een import), dan valt dit terug op de
 * eerste optie die matcht met de al genormaliseerde `status` — zo krijgt de
 * select bij "Bewerken" altijd een geldige, zinvolle startwaarde, en verliest
 * een import met afwijkende tekst zijn ACTIVE/INACTIVE-classificatie niet
 * totdat de gebruiker hier zelf expliciet opnieuw opslaat.
 */
/**
 * Visuele-polish-sprint §5: dezelfde 4 statuswaarden als de Excel-export
 * (`ArticleSnapshotStatus`) staan hier in de Historiek-tabel al langer als
 * kale tekst — deze mapping geeft elke waarde enkel een kleuraccent/badge,
 * zonder de tekst of de onderliggende data te wijzigen.
 */
const HISTORY_STATUS_BADGE_CLASS: Record<string, string> = {
  GETELD: "review-row__badge--counted",
  "0 BEVESTIGD": "review-row__badge--manual",
  OVERGENOMEN: "review-row__badge--control",
  "OVERGENOMEN - NIET GETELD": "review-row__badge--not-counted",
};

/** Percentagevariant van `formatSignedEuro` — zelfde conventie als `domain/comparison.ts`s (private) `formatSignedPercent`. */
function formatSignedPercent(value: number | null): string {
  if (value === null) return "—";
  const formatted = Math.abs(value).toFixed(1);
  if (value > 0) return `+${formatted}%`;
  if (value < 0) return `-${formatted}%`;
  return `${formatted}%`;
}

/**
 * Sprint 3.1 §5/§7: de 3 nieuwe prijsgerelateerde Historiek-kolommen tonen
 * expliciet "onbekend" i.p.v. het generieke "—" van de andere kolommen —
 * dit is een bevroren historisch punt waarvoor simpelweg geen betrouwbare
 * kostprijs bekend is (bv. een legacy-sessie zonder `FinalizedSessionResult`),
 * en dat mag nooit met een fictieve 0 of met "niet van toepassing" verward
 * worden.
 */
function formatKostprijsCell(point: MergedArticleHistoryPoint): string {
  return point.costPrice === null ? "onbekend" : formatEuro(point.costPrice);
}
function formatPrijswijzigingCell(point: MergedArticleHistoryPoint): string {
  if (point.costPrice === null) return "onbekend";
  if (point.priceDifference === null) return "—";
  const pct = point.pricePercentChange;
  return `${formatSignedEuro(point.priceDifference)}${pct !== null ? ` (${formatSignedPercent(pct)})` : ""}`;
}
function formatVoorraadwaardeCell(point: MergedArticleHistoryPoint): string {
  return point.stockValue === null ? "onbekend" : formatEuro(point.stockValue);
}

function matchArticleStatusOption(
  rawStatus: string | null,
  status: "ACTIVE" | "INACTIVE",
): (typeof ARTICLE_STATUS_OPTIONS)[number] {
  const normalized = (rawStatus ?? "").trim().toUpperCase();
  return (
    ARTICLE_STATUS_OPTIONS.find((option) => option.raw.toUpperCase() === normalized) ??
    ARTICLE_STATUS_OPTIONS.find((option) => option.status === status) ??
    ARTICLE_STATUS_OPTIONS[0]
  );
}

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
  // Aanvulling ("Bij Artikel moeten er gemakkelijk wijzigingen aangebracht
  // kunnen worden aan: omschrijving, productgroep, leverancier, en de prijs
  // moet ook zichtbaar zijn"): eenvoudige inline-bewerkmodus voor die 4
  // velden op de "Algemeen"-kaart, i.p.v. een aparte pagina/wizard — past
  // bij de bestaande filosofie hier ("elke actie past het domeinmodel meteen
  // aan, zonder apart opslaan-moment" — enkel dit ene kaartje heeft nu wél
  // een expliciete "Opslaan", omdat vrije tekst/prijs anders bij elke
  // toetsaanslag zou wegschrijven).
  const [editingGeneral, setEditingGeneral] = useState(false);
  const [draftDescription, setDraftDescription] = useState("");
  const [draftProductGroup, setDraftProductGroup] = useState("");
  const [draftSupplier, setDraftSupplier] = useState("");
  const [draftCostPrice, setDraftCostPrice] = useState("");
  // Aanvulling ("telperiode en status moet je ook kunnen aanpassen"): dezelfde
  // inline-bewerkmodus als hierboven, nu ook voor Telperiode (een vaste
  // `ArticleCountFrequency`) en Status (een vaste ruwe tekst uit
  // `ARTICLE_STATUS_OPTIONS` — zie domain/frequency.ts). Beide zijn selects
  // i.p.v. vrije tekst: dit zijn genormaliseerde, businesslogica-gestuurde
  // velden (sessiescope/telfrequentie resp. actief/inactief), geen vrije tekst
  // zoals omschrijving/productgroep/leverancier.
  const [draftCountPeriod, setDraftCountPeriod] = useState<ArticleCountFrequency>("MONTHLY");
  const [draftStatusRaw, setDraftStatusRaw] = useState<string>(ARTICLE_STATUS_OPTIONS[0].raw);
  // Sprint 2 (Historical Count Analysis) §5: voorraadclassificatie
  // (ACTIVE/OBSOLETE) — een APARTE as t.o.v. Status hierboven, zie
  // domain/stockClassification.ts. Zelfde inline-bewerkmodus als de andere
  // velden op deze kaart.
  const [draftStockClassification, setDraftStockClassification] = useState<StockClassification>("ACTIVE");
  const [savingGeneral, setSavingGeneral] = useState(false);

  const article = articles.find((a) => a.id === articleId);

  if (!article || !office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  function startEditingGeneral() {
    if (!article) return;
    setError(null);
    setDraftDescription(article.description);
    setDraftProductGroup(article.productGroup ?? "");
    setDraftSupplier(article.supplier ?? "");
    setDraftCostPrice(article.costPrice !== null ? String(article.costPrice) : "");
    setDraftCountPeriod(article.countPeriod);
    setDraftStatusRaw(matchArticleStatusOption(article.rawStatus, article.status).raw);
    setDraftStockClassification(getStockClassification(article));
    setEditingGeneral(true);
  }

  async function saveGeneral() {
    if (!article) return;
    setError(null);
    const trimmedDescription = draftDescription.trim();
    if (trimmedDescription.length === 0) {
      setError("Omschrijving mag niet leeg zijn.");
      return;
    }
    const normalizedPrice = draftCostPrice.trim().replace(",", ".");
    const parsedPrice = normalizedPrice === "" ? null : Number(normalizedPrice);
    if (parsedPrice !== null && !Number.isFinite(parsedPrice)) {
      setError("Kostprijs is geen geldig getal.");
      return;
    }
    const statusOption =
      ARTICLE_STATUS_OPTIONS.find((option) => option.raw === draftStatusRaw) ?? ARTICLE_STATUS_OPTIONS[0];
    setSavingGeneral(true);
    try {
      await countingRepository.saveArticles([
        {
          ...article,
          description: trimmedDescription,
          productGroup: draftProductGroup.trim() === "" ? null : draftProductGroup.trim(),
          supplier: draftSupplier.trim() === "" ? null : draftSupplier.trim(),
          costPrice: parsedPrice,
          countPeriod: draftCountPeriod,
          rawCountPeriod: FREQUENCY_TO_RAW[draftCountPeriod],
          status: statusOption.status,
          rawStatus: statusOption.raw,
          stockClassification: draftStockClassification,
        },
      ]);
      setEditingGeneral(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het opslaan.");
    } finally {
      setSavingGeneral(false);
    }
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

  // Enkel punten met een gekende voorraad kunnen getekend worden (een
  // OVERGENOMEN artikel zonder ooit een vorige fysieke telling heeft
  // `totalCount: null` — spec: nooit een fictieve/geschatte waarde tonen).
  const chartPoints: SimpleLineChartPoint[] = [];
  for (const point of history) {
    if (point.totalCount === null) continue;
    chartPoints.push({
      label: new Date(point.date).toLocaleDateString("nl-BE", { day: "2-digit", month: "2-digit" }),
      value: point.totalCount,
    });
  }

  // Sprint 3.1 §4: aparte, tweede lijngrafiek voor de kostprijsevolutie —
  // dezelfde chronologische, betrouwbare snapshots als hierboven, maar
  // GEEN dubbele Y-as in één grafiek: enkel punten met een gekende bevroren
  // kostprijs worden getekend (spec §7: nooit een onbekende prijs verzinnen).
  const priceChartPoints: SimpleLineChartPoint[] = [];
  for (const point of history) {
    if (point.costPrice === null) continue;
    const tooltipParts = [formatEuro(point.costPrice)];
    if (point.priceDifference !== null) {
      const pct = point.pricePercentChange;
      tooltipParts.push(`${formatSignedEuro(point.priceDifference)}${pct !== null ? ` (${formatSignedPercent(pct)})` : ""}`);
    }
    priceChartPoints.push({
      label: new Date(point.date).toLocaleDateString("nl-BE", { day: "2-digit", month: "2-digit" }),
      value: point.costPrice,
      valueLabel: formatEuro(point.costPrice),
      tooltip: tooltipParts.join(" · "),
    });
  }

  return (
    <div className="stack">
      <h1 className="screen-title">{article.description || "(geen omschrijving)"}</h1>
      <p className="screen-subtitle">{article.articleNumber}</p>

      {error && <div className="error-banner">{error}</div>}

      <div className="card stack stack--tight">
        <div className="filter-row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Algemeen</h2>
          {!editingGeneral && (
            <button type="button" className="chip" onClick={startEditingGeneral}>
              Bewerken
            </button>
          )}
        </div>
        <div className="article-detail-field">
          <span className="article-detail-field__label">Artikelnummer</span>
          <span className="article-detail-field__value">{article.articleNumber}</span>
        </div>

        {editingGeneral ? (
          <>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Omschrijving</span>
              <input
                className="search-input"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
              />
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Productgroep</span>
              <input
                className="search-input"
                value={draftProductGroup}
                onChange={(e) => setDraftProductGroup(e.target.value)}
              />
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Leverancier</span>
              <input
                className="search-input"
                value={draftSupplier}
                onChange={(e) => setDraftSupplier(e.target.value)}
              />
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Kostprijs</span>
              <input
                className="search-input"
                inputMode="decimal"
                placeholder="—"
                value={draftCostPrice}
                onChange={(e) => setDraftCostPrice(e.target.value)}
              />
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Telperiode</span>
              <select
                className="search-input"
                style={{ width: "auto" }}
                value={draftCountPeriod}
                onChange={(e) => setDraftCountPeriod(e.target.value as ArticleCountFrequency)}
              >
                {(Object.keys(FREQUENCY_FILTER_LABELS) as ArticleCountFrequency[]).map((period) => (
                  <option key={period} value={period}>
                    {FREQUENCY_FILTER_LABELS[period]}
                  </option>
                ))}
              </select>
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Status</span>
              <select
                className="search-input"
                style={{ width: "auto" }}
                value={draftStatusRaw}
                onChange={(e) => setDraftStatusRaw(e.target.value)}
              >
                {ARTICLE_STATUS_OPTIONS.map((option) => (
                  <option key={option.raw} value={option.raw}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Voorraadclassificatie</span>
              <select
                className="search-input"
                style={{ width: "auto" }}
                value={draftStockClassification}
                onChange={(e) => setDraftStockClassification(e.target.value as StockClassification)}
              >
                {(Object.keys(STOCK_CLASSIFICATION_LABELS) as StockClassification[]).map((classification) => (
                  <option key={classification} value={classification}>
                    {STOCK_CLASSIFICATION_LABELS[classification]}
                  </option>
                ))}
              </select>
            </div>
            <div className="stack stack--row">
              <BigButton variant="primary" style={{ width: "auto" }} disabled={savingGeneral} onClick={saveGeneral}>
                {savingGeneral ? "Bezig..." : "Opslaan"}
              </BigButton>
              <BigButton
                variant="ghost"
                style={{ width: "auto" }}
                disabled={savingGeneral}
                onClick={() => {
                  setEditingGeneral(false);
                  setError(null);
                }}
              >
                Annuleren
              </BigButton>
            </div>
          </>
        ) : (
          <>
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
              <span className="article-detail-field__label">Kostprijs</span>
              <span className="article-detail-field__value">{formatEuro(article.costPrice)}</span>
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Telperiode</span>
              <span className="article-detail-field__value">{FREQUENCY_FILTER_LABELS[article.countPeriod]}</span>
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Status</span>
              <span className="article-detail-field__value">
                {matchArticleStatusOption(article.rawStatus, article.status).label}
              </span>
            </div>
            <div className="article-detail-field">
              <span className="article-detail-field__label">Voorraadclassificatie</span>
              <span className="article-detail-field__value">
                {STOCK_CLASSIFICATION_LABELS[getStockClassification(article)]}
              </span>
            </div>
          </>
        )}

        <div className="article-detail-field">
          <span className="article-detail-field__label">Eenheid</span>
          <span className="article-detail-field__value">{article.unit ?? "—"}</span>
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
          <div className="stack stack--tight stack--row">
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
        <h2 style={{ margin: 0 }}>Kostprijsevolutie</h2>
        <SimpleLineChart
          points={priceChartPoints}
          ariaLabel="Kostprijsevolutie"
          emptyStateLabel="Nog geen betrouwbare historische kostprijs gekend voor dit artikel."
        />
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Historiek</h2>
        {history.length === 0 ? (
          <p className="empty-state">Nog geen afgeronde tellingen voor dit artikel.</p>
        ) : (
          <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Teldatum</th>
                <th>Telling</th>
                <th>Totale voorraad</th>
                <th>Kostprijs</th>
                <th>Prijswijziging</th>
                <th>Voorraadwaarde</th>
                <th>Verschil</th>
                <th>Locaties</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...history].reverse().map((point) => (
                <tr key={point.sessionName}>
                  <td>{formatDate(point.date)}</td>
                  <td>{point.sessionName}</td>
                  <td>{point.totalCount}</td>
                  <td>{formatKostprijsCell(point)}</td>
                  <td>{formatPrijswijzigingCell(point)}</td>
                  <td>{formatVoorraadwaardeCell(point)}</td>
                  <td>{formatSignedCount(point.difference)}</td>
                  <td>{point.locationNames.length > 0 ? point.locationNames.join(", ") : "—"}</td>
                  <td>
                    <span
                      className={`review-row__badge ${HISTORY_STATUS_BADGE_CLASS[point.status] ?? ""}`}
                    >
                      {point.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
