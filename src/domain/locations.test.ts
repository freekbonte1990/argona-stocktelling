import { describe, expect, it } from "vitest";
import {
  activeLocationsInOrder,
  addLocation,
  canHardDeleteLocation,
  removeUnusedLocation,
  renameLocation,
  reorderLocations,
  sessionLocations,
  setLocationActive,
} from "./locations";
import type { ArticleLocationAssignment, CountEntry, Location, Office } from "./types";

function buildOffice(locationCount: number): Office {
  const locations: Location[] = Array.from({ length: locationCount }, (_, i) => ({
    id: `office:loc-${i + 1}`,
    officeId: "office",
    number: i + 1,
    name: `Rek ${i + 1}`,
    active: true,
  }));
  return { id: "office", name: "Testkantoor", baseDate: null, locations };
}

describe("locatiebeheer (domain/locations.ts)", () => {
  it("een kantoor met 3 locaties werkt zonder enige vaste 5-aanname", () => {
    const office = buildOffice(3);
    expect(office.locations).toHaveLength(3);
    expect(activeLocationsInOrder(office).map((l) => l.name)).toEqual(["Rek 1", "Rek 2", "Rek 3"]);
  });

  it("een kantoor met 7 locaties werkt evengoed", () => {
    const office = buildOffice(7);
    expect(office.locations).toHaveLength(7);
    expect(activeLocationsInOrder(office).map((l) => l.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("locatie toevoegen krijgt het volgende vrije nummer en blijft actief", () => {
    const office = buildOffice(3);
    const updated = addLocation(office, "Nieuwe locatie", "office:loc-4");
    expect(updated.locations).toHaveLength(4);
    const added = updated.locations.find((l) => l.id === "office:loc-4");
    expect(added).toMatchObject({ name: "Nieuwe locatie", number: 4, active: true });
  });

  it("locatie toevoegen met lege naam valt terug op 'Locatie N'", () => {
    const office = buildOffice(1);
    const updated = addLocation(office, "   ", "office:loc-2");
    expect(updated.locations[1].name).toBe("Locatie 2");
  });

  it("locatie hernoemen wijzigt enkel de naam, niet het ID", () => {
    const office = buildOffice(3);
    const updated = renameLocation(office, "office:loc-2", "Koelcel");
    expect(updated.locations.find((l) => l.id === "office:loc-2")?.name).toBe("Koelcel");
    expect(updated.locations).toHaveLength(3);
  });

  it("een ongebruikte locatie kan hard verwijderd worden en de rest hernummert aaneensluitend", () => {
    const office = buildOffice(3);
    const updated = removeUnusedLocation(office, "office:loc-2", [], []);
    expect(updated.locations.map((l) => l.id)).toEqual(["office:loc-1", "office:loc-3"]);
    expect(updated.locations.map((l) => l.number)).toEqual([1, 2]);
  });

  it("een reeds gebruikte locatie (assignment) kan NIET hard verwijderd worden", () => {
    const office = buildOffice(3);
    const assignments: ArticleLocationAssignment[] = [
      {
        id: "a1",
        officeId: "office",
        articleId: "art-1",
        locationId: "office:loc-2",
        active: true,
        lastSeenAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    expect(canHardDeleteLocation("office:loc-2", assignments, [])).toBe(false);
    expect(() => removeUnusedLocation(office, "office:loc-2", assignments, [])).toThrow(
      /kan niet verwijderd worden/,
    );
  });

  it("een reeds gebruikte locatie (enkel CountEntry, geen assignment) kan ook NIET hard verwijderd worden", () => {
    const entries: CountEntry[] = [
      {
        id: "e1",
        sessionId: "s1",
        articleId: "art-1",
        locationId: "office:loc-2",
        quantity: 4,
        counted: true,
        countedAt: "2026-09-01T00:00:00.000Z",
        note: null,
        resolution: "COUNTED",
      },
    ];
    expect(canHardDeleteLocation("office:loc-2", [], entries)).toBe(false);
  });

  it("een gebruikte locatie kan wel inactief gemaakt worden, en behoudt haar ID", () => {
    const office = buildOffice(3);
    const updated = setLocationActive(office, "office:loc-2", false);
    expect(updated.locations).toHaveLength(3);
    const loc = updated.locations.find((l) => l.id === "office:loc-2");
    expect(loc?.active).toBe(false);
    expect(activeLocationsInOrder(updated).map((l) => l.id)).toEqual([
      "office:loc-1",
      "office:loc-3",
    ]);
  });

  it("de laatste actieve locatie mag niet inactief gemaakt worden", () => {
    const office = buildOffice(1);
    expect(() => setLocationActive(office, "office:loc-1", false)).toThrow(
      /minstens één actieve locatie/,
    );
  });

  it("een inactieve locatie kan opnieuw actief gemaakt worden", () => {
    const office = setLocationActive(buildOffice(2), "office:loc-1", false);
    const reactivated = setLocationActive(office, "office:loc-1", true);
    expect(reactivated.locations.find((l) => l.id === "office:loc-1")?.active).toBe(true);
  });

  it("locatievolgorde aanpassen herschikt de nummers volgens de gegeven ID-volgorde", () => {
    const office = buildOffice(3);
    const updated = reorderLocations(office, ["office:loc-3", "office:loc-1", "office:loc-2"]);
    expect(updated.locations.find((l) => l.id === "office:loc-3")?.number).toBe(1);
    expect(updated.locations.find((l) => l.id === "office:loc-1")?.number).toBe(2);
    expect(updated.locations.find((l) => l.id === "office:loc-2")?.number).toBe(3);
  });

  it("locatievolgorde aanpassen met een onvolledige/foute lijst wijzigt niets", () => {
    const office = buildOffice(3);
    const updated = reorderLocations(office, ["office:loc-1", "office:loc-2"]);
    expect(updated).toEqual(office);
  });

  describe("sessionLocations (data-integriteit-sprint §5: bevroren session.locationIds)", () => {
    it("zonder locationIds (oudere sessie): valt terug op de live actieve locaties", () => {
      const office = buildOffice(3);
      expect(sessionLocations({}, office).map((l) => l.id)).toEqual([
        "office:loc-1",
        "office:loc-2",
        "office:loc-3",
      ]);
    });

    it("met locationIds: enkel de bevroren set, ongeacht latere wijzigingen aan office.locations", () => {
      const office = buildOffice(3);
      const frozen = { locationIds: ["office:loc-1", "office:loc-2"] };
      expect(sessionLocations(frozen, office).map((l) => l.id)).toEqual([
        "office:loc-1",
        "office:loc-2",
      ]);
    });

    it("een locatie die NA sessiestart inactief gemaakt werd, blijft verplicht voor deze sessie", () => {
      const office = setLocationActive(buildOffice(3), "office:loc-2", false);
      const frozen = { locationIds: ["office:loc-1", "office:loc-2", "office:loc-3"] };
      // Ondanks dat loc-2 nu inactief is, staat ze nog in de bevroren set.
      expect(sessionLocations(frozen, office).map((l) => l.id)).toEqual([
        "office:loc-1",
        "office:loc-2",
        "office:loc-3",
      ]);
    });

    it("een locatie die pas NA sessiestart werd toegevoegd, wordt niet plots verplicht", () => {
      const office = addLocation(buildOffice(2), "Nieuw rek", "office:loc-3");
      const frozen = { locationIds: ["office:loc-1", "office:loc-2"] };
      expect(sessionLocations(frozen, office).map((l) => l.id)).toEqual([
        "office:loc-1",
        "office:loc-2",
      ]);
    });

    it("respecteert de weergavevolgorde (number), niet de volgorde in locationIds zelf", () => {
      const office = buildOffice(3);
      const frozen = { locationIds: ["office:loc-3", "office:loc-1"] };
      expect(sessionLocations(frozen, office).map((l) => l.id)).toEqual([
        "office:loc-1",
        "office:loc-3",
      ]);
    });
  });
});
