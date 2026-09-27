import { useMemo, useState } from "react";
import { countingRepository, locationAssignmentService, productCategoryService } from "../../application/container";
import { applyAssortmentActive, isArticleActiveInAssortment } from "../../domain/articleAssortment";
import { resolveCategoryLabel } from "../../domain/productCategory";
import type { Article, Location, ProductCategory } from "../../domain/types";
import { BigButton } from "./BigButton";

type BulkAction = "ADD" | "REMOVE" | "MOVE" | "SET_CATEGORY" | "SET_ASSORTMENT";

const BULK_ACTION_TITLES: Record<BulkAction, string> = {
  ADD: "Locatie toevoegen",
  REMOVE: "Locatie verwijderen",
  MOVE: "Verplaatsen naar",
  SET_CATEGORY: "Productgamma wijzigen",
  SET_ASSORTMENT: "Assortiment wijzigen",
};

interface ArticleBulkListProps {
  officeId: string;
  /** Al gefilterde + gesorteerde artikelen, klaar om te tonen. */
  articles: Article[];
  /** Actieve locaties van het kantoor, voor de bulkmodal en per-rij "+ Locatie". */
  activeLocations: Location[];
  locationById: Map<string, Location>;
  /** Actieve locatie-ID's per artikel (spec §3/§6). */
  locationIdsByArticle: Map<string, Set<string>>;
  /** Sprint 3.2 §8: actieve productgamma's, voor de bulkactie "Productgamma wijzigen" + de weergavenaam per rij. */
  activeCategories: ProductCategory[];
  categoriesById: Map<string, ProductCategory>;
  onOpenArticle: (articleId: string) => void;
}

/**
 * Gedeelde bulkselectie- en bulklocatiebeheer-UI (v0.2.1 correctieronde §1):
 * checkbox per rij + "Selecteer alles", de bulkbalk (Locatie toevoegen/
 * verwijderen/Verplaatsen naar) en de per-rij locatiechips + quick "+
 * Locatie". Bewust uit `ArticlesPage` getrokken zodat `WithoutLocationPage`
 * dezelfde bulk-logica en `LocationAssignmentService`-aanroepen hergebruikt
 * i.p.v. een tweede, parallel systeem te bouwen (expliciete eis uit de
 * spec). De filter/sorteer-UI errond blijft bij elke pagina apart, want die
 * verschilt bewust (volledige toolbar op Artikels, enkel
 * zoeken/sorteren/productgroep op "Zonder locatie").
 */
export function ArticleBulkList({
  officeId,
  articles,
  activeLocations,
  locationById,
  locationIdsByArticle,
  activeCategories,
  categoriesById,
  onOpenArticle,
}: ArticleBulkListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [categoryTarget, setCategoryTarget] = useState<string | null>(null);
  const [assortmentTarget, setAssortmentTarget] = useState<boolean | null>(null);
  const [quickAddArticleId, setQuickAddArticleId] = useState<string | null>(null);
  const [quickAddLocationId, setQuickAddLocationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filteredIds = useMemo(() => articles.map((a) => a.id), [articles]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));

  function toggleSelected(articleId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) next.delete(articleId);
      else next.add(articleId);
      return next;
    });
  }

  function toggleSelectAllFiltered() {
    setSelectedIds((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        for (const id of filteredIds) next.delete(id);
        return next;
      }
      return new Set([...prev, ...filteredIds]);
    });
  }

  function closeBulkModal() {
    setBulkAction(null);
    setMoveTarget(null);
    setCategoryTarget(null);
    setAssortmentTarget(null);
  }

  async function runCategoryBulkAction(categoryId: string) {
    setError(null);
    setBusy(true);
    try {
      await productCategoryService.assignArticles(officeId, Array.from(selectedIds), categoryId);
      closeBulkModal();
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het wijzigen van het productgamma.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sprint 3.3 §1: bulk "office assignment" — de geselecteerde artikelen in
   * één keer actief/inactief maken in het assortiment van dit kantoor. Zelfde
   * directe-repository-precedent als ArticleDetailPage's "Algemeen"-kaart
   * (geen apart service-object nodig voor één simpele veldwijziging); de pure
   * berekening zelf zit in `domain/articleAssortment.ts#applyAssortmentActive`.
   */
  async function runAssortmentBulkAction(active: boolean) {
    setError(null);
    setBusy(true);
    try {
      const updated = applyAssortmentActive(articles, selectedIds, active);
      if (updated.length > 0) {
        await countingRepository.saveArticles(updated);
      }
      closeBulkModal();
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het wijzigen van het assortiment.");
    } finally {
      setBusy(false);
    }
  }

  async function runBulkAction(locationId: string) {
    if (!bulkAction) return;
    setError(null);
    setBusy(true);
    try {
      const ids = Array.from(selectedIds);
      if (bulkAction === "ADD") {
        await locationAssignmentService.addLocation(officeId, ids, locationId);
      } else if (bulkAction === "REMOVE") {
        await locationAssignmentService.removeLocation(officeId, ids, locationId);
      } else {
        await locationAssignmentService.moveToLocation(officeId, ids, locationId);
      }
      closeBulkModal();
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het aanpassen van locaties.");
    } finally {
      setBusy(false);
    }
  }

  function handlePickBulkLocation(locationId: string) {
    if (bulkAction === "MOVE") {
      setMoveTarget(locationId);
      return;
    }
    void runBulkAction(locationId);
  }

  function handlePickBulkCategory(categoryId: string) {
    setCategoryTarget(categoryId);
  }

  async function handleQuickAdd(articleId: string) {
    if (!quickAddLocationId) return;
    setError(null);
    try {
      await locationAssignmentService.addLocation(officeId, [articleId], quickAddLocationId);
      setQuickAddArticleId(null);
      setQuickAddLocationId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het toevoegen van de locatie.");
    }
  }

  async function handleRemoveChip(articleId: string, locationId: string) {
    setError(null);
    try {
      await locationAssignmentService.removeLocation(officeId, [articleId], locationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout bij het verwijderen van de locatie.");
    }
  }

  return (
    <div className="stack">
      {error && <div className="error-banner">{error}</div>}

      <div className="filter-row" style={{ alignItems: "center" }}>
        <label className="filter-row" style={{ alignItems: "center", gap: "var(--space-2)" }}>
          <input
            type="checkbox"
            className="article-row__checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAllFiltered}
            aria-label="Selecteer alle gefilterde artikelen"
          />
          <span className="screen-subtitle" style={{ margin: 0 }}>
            Selecteer alles ({articles.length} gefilterd)
          </span>
        </label>
      </div>

      {selectedIds.size > 0 && (
        <div className="bulk-bar bulk-bar--sticky">
          <span className="bulk-bar__count">{selectedIds.size} artikel(en) geselecteerd</span>
          <div className="bulk-bar__actions">
            <button type="button" className="chip" onClick={() => setBulkAction("ADD")}>
              Locatie toevoegen
            </button>
            <button type="button" className="chip" onClick={() => setBulkAction("REMOVE")}>
              Locatie verwijderen
            </button>
            <button type="button" className="chip" onClick={() => setBulkAction("MOVE")}>
              Verplaatsen naar
            </button>
            <button type="button" className="chip" onClick={() => setBulkAction("SET_CATEGORY")}>
              Productgamma wijzigen
            </button>
            <button type="button" className="chip" onClick={() => setBulkAction("SET_ASSORTMENT")}>
              Assortiment wijzigen
            </button>
            <button type="button" className="chip" onClick={() => setSelectedIds(new Set())}>
              Selectie wissen
            </button>
          </div>
        </div>
      )}

      <div className="stack stack--tight">
        {articles.length === 0 && <p className="empty-state">Geen artikelen voor dit filter.</p>}
        {articles.map((article) => (
          <ArticleRow
            key={article.id}
            article={article}
            selected={selectedIds.has(article.id)}
            onToggleSelected={() => toggleSelected(article.id)}
            onOpen={() => onOpenArticle(article.id)}
            locations={Array.from(locationIdsByArticle.get(article.id) ?? [])
              .map((id) => locationById.get(id))
              .filter((l): l is Location => !!l)}
            availableLocationsToAdd={activeLocations.filter(
              (l) => !(locationIdsByArticle.get(article.id) ?? new Set()).has(l.id),
            )}
            quickAddOpen={quickAddArticleId === article.id}
            categoryLabel={resolveCategoryLabel(article.categoryId, categoriesById)}
            quickAddLocationId={quickAddArticleId === article.id ? quickAddLocationId : ""}
            onOpenQuickAdd={() => {
              setQuickAddArticleId(article.id);
              setQuickAddLocationId("");
            }}
            onCloseQuickAdd={() => setQuickAddArticleId(null)}
            onQuickAddLocationChange={setQuickAddLocationId}
            onQuickAddConfirm={() => handleQuickAdd(article.id)}
            onRemoveChip={(locationId) => handleRemoveChip(article.id, locationId)}
          />
        ))}
      </div>

      {bulkAction && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            {bulkAction === "MOVE" && moveTarget ? (
              <>
                <p style={{ margin: 0, fontWeight: 700 }}>Verplaatsen bevestigen</p>
                <p className="screen-subtitle" style={{ margin: 0 }}>
                  De huidige verwachte locatie(s) van {selectedIds.size} artikel(en) worden vervangen door "
                  {locationById.get(moveTarget)?.name}". Historische tellingen blijven volledig behouden.
                </p>
                <div className="stack">
                  <BigButton variant="primary" disabled={busy} onClick={() => runBulkAction(moveTarget)}>
                    Bevestigen
                  </BigButton>
                  <BigButton variant="ghost" disabled={busy} onClick={() => setMoveTarget(null)}>
                    Terug
                  </BigButton>
                </div>
              </>
            ) : bulkAction === "SET_CATEGORY" && categoryTarget ? (
              <>
                <p style={{ margin: 0, fontWeight: 700 }}>Productgamma wijzigen bevestigen</p>
                {/* Sprint 3.2 §8: exacte bevestigingstekst uit de spec. */}
                <p className="screen-subtitle" style={{ margin: 0 }}>
                  {selectedIds.size} artikelen worden toegewezen aan {categoriesById.get(categoryTarget)?.name}. Dit
                  wijzigt ook hun indeling in historische managementanalyses. Historische brongegevens blijven
                  ongewijzigd.
                </p>
                <div className="stack">
                  <BigButton variant="primary" disabled={busy} onClick={() => runCategoryBulkAction(categoryTarget)}>
                    Bevestigen
                  </BigButton>
                  <BigButton variant="ghost" disabled={busy} onClick={() => setCategoryTarget(null)}>
                    Terug
                  </BigButton>
                </div>
              </>
            ) : bulkAction === "SET_ASSORTMENT" && assortmentTarget !== null ? (
              <>
                <p style={{ margin: 0, fontWeight: 700 }}>Assortiment wijzigen bevestigen</p>
                <p className="screen-subtitle" style={{ margin: 0 }}>
                  {selectedIds.size} artikel(en) worden {assortmentTarget ? "actief" : "inactief"} gemaakt in het
                  assortiment van dit kantoor.
                  {!assortmentTarget &&
                    " Ze blijven volledig zichtbaar in historische tellingen en analyses, maar worden vanaf nu niet meer opgenomen in nieuwe tellingen."}
                </p>
                <div className="stack">
                  <BigButton
                    variant="primary"
                    disabled={busy}
                    onClick={() => runAssortmentBulkAction(assortmentTarget)}
                  >
                    Bevestigen
                  </BigButton>
                  <BigButton variant="ghost" disabled={busy} onClick={() => setAssortmentTarget(null)}>
                    Terug
                  </BigButton>
                </div>
              </>
            ) : bulkAction === "SET_ASSORTMENT" ? (
              <>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {BULK_ACTION_TITLES[bulkAction]} — {selectedIds.size} artikel(en) geselecteerd
                </p>
                <div className="stack stack--tight">
                  <BigButton variant="secondary" disabled={busy} onClick={() => setAssortmentTarget(true)}>
                    Actief in assortiment
                  </BigButton>
                  <BigButton variant="secondary" disabled={busy} onClick={() => setAssortmentTarget(false)}>
                    Inactief (historisch)
                  </BigButton>
                </div>
              </>
            ) : bulkAction === "SET_CATEGORY" ? (
              <>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {BULK_ACTION_TITLES[bulkAction]} — {selectedIds.size} artikel(en) geselecteerd
                </p>
                <p className="screen-subtitle" style={{ margin: 0 }}>
                  Kies een productgamma.
                </p>
                <div className="stack stack--tight">
                  {activeCategories.length === 0 && (
                    <p className="empty-state">Nog geen productgamma's aangemaakt — dat kan bij Instellingen.</p>
                  )}
                  {activeCategories.map((category) => (
                    <BigButton
                      key={category.id}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => handlePickBulkCategory(category.id)}
                    >
                      {category.name}
                    </BigButton>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {BULK_ACTION_TITLES[bulkAction]} — {selectedIds.size} artikel(en) geselecteerd
                </p>
                <p className="screen-subtitle" style={{ margin: 0 }}>
                  Kies een locatie.
                </p>
                <div className="stack stack--tight">
                  {activeLocations.map((location) => (
                    <BigButton
                      key={location.id}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => handlePickBulkLocation(location.id)}
                    >
                      {location.name}
                    </BigButton>
                  ))}
                </div>
              </>
            )}
            <BigButton variant="ghost" disabled={busy} onClick={closeBulkModal}>
              Annuleren
            </BigButton>
          </div>
        </div>
      )}
    </div>
  );
}

interface ArticleRowProps {
  article: Article;
  selected: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
  locations: Location[];
  categoryLabel: string;
  availableLocationsToAdd: Location[];
  quickAddOpen: boolean;
  quickAddLocationId: string;
  onOpenQuickAdd: () => void;
  onCloseQuickAdd: () => void;
  onQuickAddLocationChange: (locationId: string) => void;
  onQuickAddConfirm: () => void;
  onRemoveChip: (locationId: string) => void;
}

/**
 * Eén artikelrij (spec §3): checkbox voor bulkselectie, omschrijving/meta
 * (klikbaar naar het artikeldetail), en de compacte locatiechips + "+
 * Locatie" voor snelle, individuele locatiebediening zonder naar het detail
 * te moeten navigeren.
 *
 * AANNAME (gedocumenteerd): "+ Locatie" is bewust een inline uitklappaneel
 * i.p.v. een écht zwevende (absoluut gepositioneerde) popover — dat is
 * betrouwbaarder op tablet. Een bestaande locatiechip "veranderen" gebeurt
 * door hem te verwijderen (×) en de gewenste locatie via "+ Locatie" opnieuw
 * toe te voegen — op bulkniveau bestaat "Verplaatsen naar" al voor dat doel.
 */
function ArticleRow({
  article,
  selected,
  onToggleSelected,
  onOpen,
  locations,
  categoryLabel,
  availableLocationsToAdd,
  quickAddOpen,
  quickAddLocationId,
  onOpenQuickAdd,
  onCloseQuickAdd,
  onQuickAddLocationChange,
  onQuickAddConfirm,
  onRemoveChip,
}: ArticleRowProps) {
  return (
    <div className={`article-row ${selected ? "article-row--selected" : ""}`}>
      <input
        type="checkbox"
        className="article-row__checkbox"
        checked={selected}
        onChange={onToggleSelected}
        aria-label={`Selecteer ${article.description || article.articleNumber}`}
      />
      <div className="article-row__body">
        <button type="button" className="article-row__open" onClick={onOpen}>
          <div className="article-card__description">{article.description || "(geen omschrijving)"}</div>
          <div className="article-card__meta">
            <span className="meta-article-number">{article.articleNumber}</span>
            <span>{categoryLabel}</span>
            <span>Telfrequentie: {article.rawCountPeriod ?? "—"}</span>
            <span>Vorige telling: {article.previousCount ?? "—"}</span>
            {!isArticleActiveInAssortment(article) && (
              <span className="review-row__badge review-row__badge--not-counted">Inactief (historisch)</span>
            )}
          </div>
        </button>

        <div className="filter-row">
          {locations.map((location) => (
            <span key={location.id} className="chip chip--active location-chip">
              <span>{location.name}</span>
              <button
                type="button"
                className="location-chip__remove"
                aria-label={`${location.name} verwijderen van dit artikel`}
                onClick={() => onRemoveChip(location.id)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="chip" onClick={quickAddOpen ? onCloseQuickAdd : onOpenQuickAdd}>
            + Locatie
          </button>
        </div>

        {quickAddOpen && (
          <div className="quick-add-panel">
            {availableLocationsToAdd.length === 0 ? (
              <span className="screen-subtitle" style={{ margin: 0 }}>
                Alle actieve locaties zijn al gekoppeld aan dit artikel.
              </span>
            ) : (
              <>
                <select
                  className="search-input"
                  style={{ flex: 1, minWidth: 160 }}
                  value={quickAddLocationId}
                  onChange={(e) => onQuickAddLocationChange(e.target.value)}
                >
                  <option value="">Kies een locatie...</option>
                  {availableLocationsToAdd.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                <BigButton
                  variant="secondary"
                  style={{ width: "auto" }}
                  disabled={!quickAddLocationId}
                  onClick={onQuickAddConfirm}
                >
                  Toevoegen
                </BigButton>
              </>
            )}
            <BigButton variant="ghost" style={{ width: "auto" }} onClick={onCloseQuickAdd}>
              Annuleren
            </BigButton>
          </div>
        )}
      </div>
    </div>
  );
}
