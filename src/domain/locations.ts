import type {
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  Location,
  Office,
} from "./types";

/**
 * Pure regels voor locatiebeheer (spec v0.2.1 §1): toevoegen, hernoemen,
 * volgorde aanpassen, en het onderscheid hard verwijderen (enkel als de
 * locatie nog nooit gebruikt is) versus inactief maken (voor een reeds
 * gebruikte locatie — historische CountEntries/assignments blijven altijd
 * geldig, want die verwijzen naar `Location.id`, nooit naar `number`).
 *
 * Puur domein: geen IndexedDB, geen React. `SettingsPage` roept deze functies
 * aan en bewaart het resultaat via `CountingRepository#saveOffice`.
 */

/** Volgende vrije weergavenummer (altijd hoogste bestaande + 1, ook na verwijderingen). */
function nextLocationNumber(locations: Location[]): number {
  return locations.length === 0 ? 1 : Math.max(...locations.map((l) => l.number)) + 1;
}

export function addLocation(office: Office, name: string, id: string): Office {
  const trimmed = name.trim();
  const number = nextLocationNumber(office.locations);
  const location: Location = {
    id,
    officeId: office.id,
    number,
    name: trimmed || `Locatie ${number}`,
    active: true,
  };
  return { ...office, locations: [...office.locations, location] };
}

export function renameLocation(office: Office, locationId: string, newName: string): Office {
  const trimmed = newName.trim();
  return {
    ...office,
    locations: office.locations.map((location) =>
      location.id === locationId
        ? { ...location, name: trimmed || `Locatie ${location.number}` }
        : location,
    ),
  };
}

/**
 * Past de weergave-/exportvolgorde aan. `orderedIds` moet exact een
 * permutatie zijn van de bestaande locatie-ID's (elke locatie precies
 * eenmaal) — anders wordt er niets gewijzigd, om nooit per ongeluk een
 * locatie te laten "verdwijnen" uit de volgorde.
 */
export function reorderLocations(office: Office, orderedIds: string[]): Office {
  const byId = new Map(office.locations.map((l) => [l.id, l]));
  if (orderedIds.length !== office.locations.length) return office;
  if (!orderedIds.every((id) => byId.has(id))) return office;
  if (new Set(orderedIds).size !== orderedIds.length) return office;

  const reordered = orderedIds.map((id, index) => ({ ...byId.get(id)!, number: index + 1 }));
  return { ...office, locations: reordered };
}

/** Is deze locatie nog nooit gebruikt (geen assignment, geen CountEntry)? Enkel dan mag ze hard verwijderd worden. */
export function canHardDeleteLocation(
  locationId: string,
  assignments: ArticleLocationAssignment[],
  entries: CountEntry[],
): boolean {
  const usedInAssignment = assignments.some((a) => a.locationId === locationId);
  const usedInEntry = entries.some((e) => e.locationId === locationId);
  return !usedInAssignment && !usedInEntry;
}

/**
 * Verwijdert een nog-nooit-gebruikte locatie hard uit de lijst en hernummert
 * de rest aaneensluitend. Gooit een fout wanneer de locatie toch al gebruikt
 * is — de UI moet in dat geval `setLocationActive(..., false)` aanbieden in
 * plaats van deze functie aan te roepen.
 */
export function removeUnusedLocation(
  office: Office,
  locationId: string,
  assignments: ArticleLocationAssignment[],
  entries: CountEntry[],
): Office {
  const location = office.locations.find((l) => l.id === locationId);
  if (!location) return office;
  if (!canHardDeleteLocation(locationId, assignments, entries)) {
    throw new Error(
      `Locatie "${location.name}" is al gebruikt in een telling en kan niet verwijderd worden — maak de locatie inactief in plaats van te verwijderen.`,
    );
  }
  const remaining = office.locations
    .filter((l) => l.id !== locationId)
    .map((l, index) => ({ ...l, number: index + 1 }));
  return { ...office, locations: remaining };
}

/**
 * Maakt een locatie actief/inactief (het "zachte verwijderen" voor een
 * reeds gebruikte locatie — spec v0.2.1 §1). Weigert de laatste actieve
 * locatie van een kantoor te deactiveren: er moet altijd minstens één
 * locatie overblijven om te kunnen tellen.
 */
export function setLocationActive(office: Office, locationId: string, active: boolean): Office {
  if (!active) {
    const otherActiveCount = office.locations.filter(
      (l) => l.id !== locationId && l.active,
    ).length;
    if (otherActiveCount === 0) {
      throw new Error("Er moet minstens één actieve locatie overblijven.");
    }
  }
  return {
    ...office,
    locations: office.locations.map((location) =>
      location.id === locationId ? { ...location, active } : location,
    ),
  };
}

/** Locaties in weergavevolgorde, enkel de actieve (voor telacties/locatie-overzicht). */
export function activeLocationsInOrder(office: Office): Location[] {
  return [...office.locations].filter((l) => l.active).sort((a, b) => a.number - b.number);
}

/** Alle locaties in weergavevolgorde (actief + inactief — bv. voor de Excel-export, die historiek nooit mag verliezen). */
export function allLocationsInOrder(office: Office): Location[] {
  return [...office.locations].sort((a, b) => a.number - b.number);
}

/**
 * Locaties die voor DEZE sessie moeten afgerond worden (data-integriteit-
 * sprint §5) — respecteert de bij sessiestart bevroren `session.locationIds`
 * in plaats van de live `office.locations`:
 *   - Een locatie die na sessiestart inactief werd gemaakt blijft in deze
 *     lijst (ze staat nog in `locationIds`), dus blijft verplicht af te
 *     ronden voor deze sessie.
 *   - Een locatie die pas ná sessiestart werd toegevoegd staat niet in
 *     `locationIds` en verschijnt dus terecht niet in deze lijst.
 *
 * Backward-compatible fallback: sessies gestart vóór deze sprint hebben geen
 * `locationIds` (`undefined`) — voor die sessies valt dit terug op het oude
 * gedrag (`activeLocationsInOrder`), zodat historische sessies zonder
 * dataverlies of crash bruikbaar blijven.
 */
export function sessionLocations(
  session: Pick<CountSession, "locationIds">,
  office: Office,
): Location[] {
  if (!session.locationIds) {
    return activeLocationsInOrder(office);
  }
  const frozen = new Set(session.locationIds);
  return [...office.locations]
    .filter((l) => frozen.has(l.id))
    .sort((a, b) => a.number - b.number);
}
