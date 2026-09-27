import { useEffect, useState } from "react";
import {
  activeLocationsInOrder,
  addLocation,
  allLocationsInOrder,
  canHardDeleteLocation,
  removeUnusedLocation,
  renameLocation,
  reorderLocations,
  setLocationActive,
} from "../../domain/locations";
import { allProductCategoriesInOrder, countArticlesInCategory } from "../../domain/productCategory";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
import type { CountSession, Location, Office, ProductCategory } from "../../domain/types";
import { generateLocationId } from "../../shared/ids";
import { countSessionService, countingRepository, productCategoryService } from "../../application/container";
import { BigButton } from "../components/BigButton";
import { LegacyImportSection } from "./LegacyImportSection";
import {
  useAllArticles,
  useAssignments,
  useOffice,
  useProductCategories,
  useSessionsForOffice,
} from "../hooks/useLiveData";

/** Sprint 3.3 §5: NL-labels voor de sessietypes, voor de "Tellingen"-lijst hieronder. */
const SESSION_TYPE_LABELS: Record<CountSession["type"], string> = {
  MONTHLY: "Maandtelling",
  QUARTERLY: "Kwartaaltelling",
  YEARLY: "Jaartelling",
  FULL: "Volledige telling",
};

interface SettingsPageProps {
  officeId: string;
}

/**
 * Locatiebeheer (spec v0.2.1 §1): een kantoor heeft een dynamische lijst
 * stocklocaties in plaats van vaste 1-5. Elke actie hier werkt rechtstreeks
 * op het domeinmodel (domain/locations.ts) en slaat het bijgewerkte kantoor
 * meteen op — geen apart "Opslaan"-moment nodig, dit is bewust geen wizard.
 */
export function SettingsPage({ officeId }: SettingsPageProps) {
  const officeOrUndefined = useOffice(officeId);
  const assignments = useAssignments(officeId) ?? [];
  const [newLocationName, setNewLocationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * Visuele-polish-sprint §7: locaties tonen voortaan als platte tekst, met
   * een expliciete "Naam wijzigen"-actie die pas dan het (ongewijzigde)
   * tekstveld toont — voorheen stond ELKE locatie altijd als open
   * invoerveld, wat op een lange lijst als een rommelige rij formuliervelden
   * oogde. Het onderliggende opslaggedrag (`handleRename`, opslaan bij het
   * verlaten van het veld) is functioneel exact hetzelfde, enkel wanneer het
   * veld zichtbaar is, is nieuw.
   */
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);

  // Sprint 3.2 §5 — "Productgamma's": zelfde interactiepatronen als
  // Stocklocaties hierboven (rechtstreeks op het domeinmodel werken, direct
  // opslaan, geen apart "Opslaan"-moment), plus een samenvoegactie (§6) die
  // een reeds gebruikte categorie nooit destructief laat verwijderen.
  //
  // Sprint 3.2.1-architectuurfix: `ProductCategory` is nu bedrijfsbreed/
  // globaal — "aantal toegewezen artikelen"/"kan verwijderd worden" moet dus
  // over ALLE kantoren gecontroleerd worden (`useAllArticles`), niet enkel
  // het hier geselecteerde kantoor. Anders zou een categorie die enkel bij
  // een ANDER kantoor in gebruik is hier ten onrechte "0 artikel(en)" en
  // verwijderbaar tonen.
  const articles = useAllArticles() ?? [];
  useEffect(() => {
    void productCategoryService.listCategories(officeId);
  }, [officeId]);
  const categories = allProductCategoriesInOrder(useProductCategories() ?? []);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string>("");

  // Sprint 3.3 §5 — "Tellingen": veilig verwijderen van afgeronde app-tellingen,
  // met expliciete bevestiging (tweestapspatroon, zelfde als het
  // samenvoegen van productgamma's hierboven).
  const sessions = useSessionsForOffice(officeId) ?? [];
  const completedSessions = sessions.filter((s) => s.status === "COMPLETED");
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);

  if (!officeOrUndefined) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }
  const office: Office = officeOrUndefined;

  const persist = async (next: Office) => {
    setError(null);
    try {
      await countingRepository.saveOffice(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const handleAdd = async () => {
    if (!newLocationName.trim()) return;
    const id = generateLocationId(office.id);
    const next = addLocation(office, newLocationName, id);
    setNewLocationName("");
    await persist(next);
  };

  const handleRename = async (locationId: string, name: string) => {
    setEditingLocationId(null);
    await persist(renameLocation(office, locationId, name));
  };

  const handleMove = async (locationId: string, direction: -1 | 1) => {
    const ordered = allLocationsInOrder(office).map((l) => l.id);
    const index = ordered.indexOf(locationId);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const reordered = [...ordered];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    await persist(reorderLocations(office, reordered));
  };

  const handleToggleActive = async (location: Location) => {
    setError(null);
    try {
      const next = setLocationActive(office, location.id, !location.active);
      await persist(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const handleDelete = async (location: Location) => {
    setError(null);
    try {
      const next = removeUnusedLocation(office, location.id, assignments, []);
      await persist(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const orderedLocations = allLocationsInOrder(office);
  const activeCount = activeLocationsInOrder(office).length;

  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) return;
    setCategoryError(null);
    try {
      await productCategoryService.addCategory(officeId, newCategoryName);
      setNewCategoryName("");
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const handleRenameCategory = async (categoryId: string, name: string) => {
    setEditingCategoryId(null);
    setCategoryError(null);
    try {
      await productCategoryService.renameCategory(officeId, categoryId, name);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const handleMoveCategory = async (categoryId: string, direction: -1 | 1) => {
    const ordered = categories.map((c) => c.id);
    const index = ordered.indexOf(categoryId);
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const reordered = [...ordered];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    await productCategoryService.reorderCategories(officeId, reordered);
  };

  const handleToggleCategoryActive = async (category: ProductCategory) => {
    setCategoryError(null);
    try {
      await productCategoryService.setCategoryActive(officeId, category.id, !category.active);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const handleDeleteCategory = async (category: ProductCategory) => {
    setCategoryError(null);
    try {
      await productCategoryService.deleteUnusedCategory(officeId, category.id);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const handleConfirmMerge = async () => {
    if (!mergeSourceId || !mergeTargetId) return;
    setCategoryError(null);
    try {
      await productCategoryService.mergeCategories(officeId, mergeSourceId, mergeTargetId);
      setMergeSourceId(null);
      setMergeTargetId("");
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Onbekende fout.");
    }
  };

  const mergeSource = categories.find((c) => c.id === mergeSourceId) ?? null;
  const mergeSourceCount = mergeSource ? countArticlesInCategory(articles, mergeSource.id) : 0;

  const sessionToDelete = completedSessions.find((s) => s.id === deleteSessionId) ?? null;

  const handleConfirmDeleteSession = async () => {
    if (!sessionToDelete) return;
    setSessionError(null);
    setDeletingSession(true);
    try {
      await countSessionService.deleteSession(sessionToDelete.id);
      setDeleteSessionId(null);
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Onbekende fout.");
    } finally {
      setDeletingSession(false);
    }
  };

  return (
    <div className="stack">
      <h1 className="screen-title">Instellingen</h1>
      <div className="card stack stack--tight">
        <div>
          <strong>Kantoor:</strong> {office.name}
        </div>
        <div>
          <strong>Basisdatum:</strong> {office.baseDate ?? "—"}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <LegacyImportSection officeId={officeId} />

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Stocklocaties</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          {activeCount} actieve locatie(s) van {orderedLocations.length} totaal. Een reeds gebruikte
          locatie kan niet verwijderd worden — enkel inactief gemaakt (historische tellingen blijven
          zo altijd leesbaar).
        </p>

        <div className="stack stack--tight">
          {orderedLocations.map((location, index) => {
            const used = !canHardDeleteLocation(location.id, assignments, []);
            const isEditing = editingLocationId === location.id;
            return (
              <div
                key={location.id}
                className={`card stack stack--tight location-settings-row ${
                  !location.active ? "location-settings-row--inactive" : ""
                }`}
              >
                <div className="stack stack--tight stack--row">
                  {isEditing ? (
                    // Bewust ONGECONTROLEERD (defaultValue, geen value): de
                    // naam komt reactief uit Dexie (useOffice), en die
                    // render-cyclus mag de cursorpositie niet verstoren
                    // tijdens het typen. Opslaan gebeurt pas bij het
                    // verlaten van het veld (of Enter) — functioneel exact
                    // hetzelfde als voorheen, enkel nu achter een expliciete
                    // "Naam wijzigen"-actie i.p.v. altijd open.
                    <input
                      key={location.id}
                      className="search-input"
                      style={{ flex: 1 }}
                      defaultValue={location.name}
                      autoFocus
                      onBlur={(e) => handleRename(location.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  ) : (
                    <>
                      <span className="location-settings-row__name">{location.name}</span>
                      <button
                        type="button"
                        className="chip chip--settings"
                        onClick={() => setEditingLocationId(location.id)}
                      >
                        Naam wijzigen
                      </button>
                    </>
                  )}
                  {!location.active && (
                    <span className="review-row__badge review-row__badge--not-counted">Inactief</span>
                  )}
                </div>
                <div className="location-settings-row__actions">
                  <div className="filter-row location-settings-row__order">
                    <button
                      type="button"
                      className="chip chip--settings"
                      aria-label="Omhoog verplaatsen"
                      disabled={index === 0}
                      onClick={() => handleMove(location.id, -1)}
                    >
                      ↑ Omhoog
                    </button>
                    <button
                      type="button"
                      className="chip chip--settings"
                      aria-label="Omlaag verplaatsen"
                      disabled={index === orderedLocations.length - 1}
                      onClick={() => handleMove(location.id, 1)}
                    >
                      ↓ Omlaag
                    </button>
                  </div>
                  <div className="filter-row">
                    <button type="button" className="chip chip--settings" onClick={() => handleToggleActive(location)}>
                      {location.active ? "Inactief maken" : "Activeren"}
                    </button>
                    {!used && (
                      <button type="button" className="chip chip--settings" onClick={() => handleDelete(location)}>
                        Verwijderen
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="stack stack--tight stack--row">
          <input
            className="search-input"
            style={{ flex: 1 }}
            placeholder="Naam nieuwe locatie..."
            value={newLocationName}
            onChange={(e) => setNewLocationName(e.target.value)}
          />
          <BigButton variant="secondary" style={{ width: "auto" }} onClick={handleAdd}>
            + Locatie
          </BigButton>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Productgamma's</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          De huidige, beheerde indeling van artikelen (bv. Zonnepanelen, Batterijen, Kabels...). Een wijziging
          hier werkt door in alle managementanalyses, ook van reeds afgeronde tellingen — de historische
          brongegevens per artikel (Bronproductgroep) blijven altijd ongewijzigd.
        </p>

        {categoryError && <div className="error-banner">{categoryError}</div>}

        <div className="stack stack--tight">
          {categories.length === 0 && (
            <p className="empty-state">Nog geen productgamma's aangemaakt.</p>
          )}
          {categories.map((category, index) => {
            const assignedCount = countArticlesInCategory(articles, category.id);
            const canDelete = assignedCount === 0;
            const isEditing = editingCategoryId === category.id;
            return (
              <div
                key={category.id}
                className={`card stack stack--tight location-settings-row ${
                  !category.active ? "location-settings-row--inactive" : ""
                }`}
              >
                <div className="stack stack--tight stack--row">
                  {isEditing ? (
                    <input
                      key={category.id}
                      className="search-input"
                      style={{ flex: 1 }}
                      defaultValue={category.name}
                      autoFocus
                      onBlur={(e) => handleRenameCategory(category.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  ) : (
                    <>
                      <span className="location-settings-row__name">{category.name}</span>
                      <button
                        type="button"
                        className="chip chip--settings"
                        onClick={() => setEditingCategoryId(category.id)}
                      >
                        Naam wijzigen
                      </button>
                    </>
                  )}
                  <span className="screen-subtitle" style={{ margin: 0 }}>
                    {assignedCount} artikel(en)
                  </span>
                  {!category.active && (
                    <span className="review-row__badge review-row__badge--not-counted">Inactief</span>
                  )}
                </div>
                <div className="location-settings-row__actions">
                  <div className="filter-row location-settings-row__order">
                    <button
                      type="button"
                      className="chip chip--settings"
                      aria-label="Omhoog verplaatsen"
                      disabled={index === 0}
                      onClick={() => handleMoveCategory(category.id, -1)}
                    >
                      ↑ Omhoog
                    </button>
                    <button
                      type="button"
                      className="chip chip--settings"
                      aria-label="Omlaag verplaatsen"
                      disabled={index === categories.length - 1}
                      onClick={() => handleMoveCategory(category.id, 1)}
                    >
                      ↓ Omlaag
                    </button>
                  </div>
                  <div className="filter-row">
                    <button
                      type="button"
                      className="chip chip--settings"
                      onClick={() => handleToggleCategoryActive(category)}
                    >
                      {category.active ? "Inactief maken" : "Activeren"}
                    </button>
                    {canDelete ? (
                      <button type="button" className="chip chip--settings" onClick={() => handleDeleteCategory(category)}>
                        Verwijderen
                      </button>
                    ) : (
                      categories.length > 1 && (
                        <button
                          type="button"
                          className="chip chip--settings"
                          onClick={() => {
                            setMergeSourceId(category.id);
                            setMergeTargetId("");
                          }}
                        >
                          Samenvoegen met...
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="stack stack--tight stack--row">
          <input
            className="search-input"
            style={{ flex: 1 }}
            placeholder="Naam nieuw productgamma..."
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
          />
          <BigButton variant="secondary" style={{ width: "auto" }} onClick={handleAddCategory}>
            + Productgamma
          </BigButton>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Tellingen</h2>
        <p className="screen-subtitle" style={{ margin: 0 }}>
          Afgeronde stocktellingen van dit kantoor. Verwijderen is definitief: de telling, haar
          resultaten en HISTORIE-regels verdwijnen, en de vorige-tellingbaseline van de betrokken
          artikelen wordt automatisch hersteld. Artikelen/mastergegevens zelf blijven altijd behouden.
        </p>

        {sessionError && <div className="error-banner">{sessionError}</div>}

        <div className="stack stack--tight">
          {completedSessions.length === 0 && (
            <p className="empty-state">Nog geen afgeronde tellingen voor dit kantoor.</p>
          )}
          {completedSessions.map((session) => (
            <div key={session.id} className="card stack stack--tight location-settings-row">
              <div className="stack stack--tight stack--row">
                <span className="location-settings-row__name">{sessionSnapshotName(session)}</span>
                <span className="screen-subtitle" style={{ margin: 0 }}>
                  {SESSION_TYPE_LABELS[session.type]} · afgerond op{" "}
                  {session.completedAt ? new Date(session.completedAt).toLocaleDateString("nl-BE") : "—"}
                </span>
              </div>
              <div className="location-settings-row__actions">
                <div className="filter-row">
                  <button
                    type="button"
                    className="chip chip--settings"
                    onClick={() => {
                      setSessionError(null);
                      setDeleteSessionId(session.id);
                    }}
                  >
                    Verwijderen
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {sessionToDelete && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>
              "{sessionSnapshotName(sessionToDelete)}" verwijderen?
            </p>
            <p className="screen-subtitle" style={{ margin: 0 }}>
              Deze telling, haar resultaten en HISTORIE-regels worden definitief verwijderd. De
              vorige-tellingbaseline van artikelen die enkel hier het laatst fysiek geteld werden,
              wordt automatisch teruggezet naar hun vorige betrouwbare telling. Deze actie kan niet
              ongedaan gemaakt worden.
            </p>
            <div className="stack">
              <BigButton variant="primary" disabled={deletingSession} onClick={handleConfirmDeleteSession}>
                {deletingSession ? "Bezig met verwijderen..." : "Verwijderen bevestigen"}
              </BigButton>
              <BigButton variant="ghost" disabled={deletingSession} onClick={() => setDeleteSessionId(null)}>
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}

      {mergeSource && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>"{mergeSource.name}" samenvoegen</p>
            <p className="screen-subtitle" style={{ margin: 0 }}>
              Kies het productgamma waar de {mergeSourceCount} artikel(en) van "{mergeSource.name}" naartoe
              verhuizen. "{mergeSource.name}" wordt daarna inactief gemaakt (niet verwijderd) — historische
              brongegevens en tellingen blijven volledig behouden.
            </p>
            <select
              className="search-input"
              value={mergeTargetId}
              onChange={(e) => setMergeTargetId(e.target.value)}
            >
              <option value="">Kies een productgamma...</option>
              {categories
                .filter((c) => c.id !== mergeSource.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <div className="stack">
              <BigButton variant="primary" disabled={!mergeTargetId} onClick={handleConfirmMerge}>
                Samenvoegen bevestigen
              </BigButton>
              <BigButton variant="ghost" onClick={() => setMergeSourceId(null)}>
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
