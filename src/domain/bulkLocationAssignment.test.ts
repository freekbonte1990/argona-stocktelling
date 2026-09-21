import { describe, expect, it } from "vitest";
import { planAddLocation, planMoveToLocation, planRemoveLocation } from "./bulkLocationAssignment";
import type { ArticleLocationAssignment } from "./types";

const OFFICE = "office-1";
const NOW = "2026-09-18T10:00:00.000Z";

function makeAssignment(overrides: Partial<ArticleLocationAssignment>): ArticleLocationAssignment {
  return {
    id: "office-1:art:loc",
    officeId: OFFICE,
    articleId: "art",
    locationId: "loc",
    active: true,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("planAddLocation (v0.2.1 bulk locatiebeheer §2)", () => {
  it("plant een actieve assignment voor elk geselecteerd artikel, voor de gekozen locatie", () => {
    const plan = planAddLocation(OFFICE, ["A1", "A2"], "loc-1", NOW);
    expect(plan).toHaveLength(2);
    expect(plan.every((a) => a.active && a.locationId === "loc-1")).toBe(true);
    expect(plan.map((a) => a.articleId).sort()).toEqual(["A1", "A2"]);
    expect(plan[0].id).toBe(`${OFFICE}:A1:loc-1`);
  });

  it("dedupliceert artikel-ID's", () => {
    const plan = planAddLocation(OFFICE, ["A1", "A1"], "loc-1", NOW);
    expect(plan).toHaveLength(1);
  });
});

describe("planRemoveLocation (v0.2.1 bulk locatiebeheer §2)", () => {
  it("deactiveert enkel de gekozen locatie voor artikelen die daar een actieve koppeling hebben", () => {
    const existing = [
      makeAssignment({ id: "office-1:A1:loc-1", articleId: "A1", locationId: "loc-1", active: true }),
      // A1 heeft ook een tweede, andere locatie — die mag niet aangeraakt worden.
      makeAssignment({ id: "office-1:A1:loc-2", articleId: "A1", locationId: "loc-2", active: true }),
    ];
    const plan = planRemoveLocation(OFFICE, ["A1"], "loc-1", existing, NOW);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ articleId: "A1", locationId: "loc-1", active: false, lastSeenAt: NOW });
  });

  it("laat een artikel zonder koppeling naar die locatie ongewijzigd (niets te plannen)", () => {
    const existing = [
      makeAssignment({ id: "office-1:A1:loc-2", articleId: "A1", locationId: "loc-2", active: true }),
    ];
    const plan = planRemoveLocation(OFFICE, ["A1"], "loc-1", existing, NOW);
    expect(plan).toHaveLength(0);
  });

  it("raakt nooit een reeds inactieve koppeling opnieuw aan", () => {
    const existing = [
      makeAssignment({ id: "office-1:A1:loc-1", articleId: "A1", locationId: "loc-1", active: false }),
    ];
    const plan = planRemoveLocation(OFFICE, ["A1"], "loc-1", existing, NOW);
    expect(plan).toHaveLength(0);
  });
});

describe("planMoveToLocation (v0.2.1 bulk locatiebeheer §2)", () => {
  it("vervangt de huidige actieve locatie(s) door de nieuwe, en behoudt historische entries niet als onderwerp van deze planning", () => {
    const existing = [
      makeAssignment({ id: "office-1:A1:loc-1", articleId: "A1", locationId: "loc-1", active: true }),
    ];
    const plan = planMoveToLocation(OFFICE, ["A1"], "loc-2", existing, NOW);
    expect(plan).toHaveLength(2);
    const deactivated = plan.find((a) => a.locationId === "loc-1");
    const activated = plan.find((a) => a.locationId === "loc-2");
    expect(deactivated).toMatchObject({ active: false });
    expect(activated).toMatchObject({ active: true, id: `${OFFICE}:A1:loc-2` });
  });

  it("verplaatst meerdere bestaande actieve locaties van hetzelfde artikel allemaal naar de nieuwe locatie", () => {
    const existing = [
      makeAssignment({ id: "office-1:A1:loc-1", articleId: "A1", locationId: "loc-1", active: true }),
      makeAssignment({ id: "office-1:A1:loc-3", articleId: "A1", locationId: "loc-3", active: true }),
    ];
    const plan = planMoveToLocation(OFFICE, ["A1"], "loc-2", existing, NOW);
    const deactivatedIds = plan.filter((a) => a.active === false).map((a) => a.locationId).sort();
    expect(deactivatedIds).toEqual(["loc-1", "loc-3"]);
    expect(plan.filter((a) => a.active === true)).toHaveLength(1);
  });

  it("is een no-op wanneer het artikel al enkel op de doellocatie actief staat", () => {
    const existing = [
      makeAssignment({ id: "office-1:A1:loc-2", articleId: "A1", locationId: "loc-2", active: true }),
    ];
    const plan = planMoveToLocation(OFFICE, ["A1"], "loc-2", existing, NOW);
    expect(plan).toHaveLength(0);
  });

  it("een artikel zonder enige bestaande locatie krijgt gewoon de nieuwe locatie toegevoegd", () => {
    const plan = planMoveToLocation(OFFICE, ["A1"], "loc-2", [], NOW);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ articleId: "A1", locationId: "loc-2", active: true });
  });
});
