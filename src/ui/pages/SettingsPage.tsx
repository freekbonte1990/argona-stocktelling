import { useState } from "react";
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
import type { Location, Office } from "../../domain/types";
import { generateLocationId } from "../../shared/ids";
import { countingRepository } from "../../application/container";
import { BigButton } from "../components/BigButton";
import { useAssignments, useOffice } from "../hooks/useLiveData";

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
    </div>
  );
}
