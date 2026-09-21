import { describe, expect, it } from "vitest";
import { buildArticleHistory } from "./articleHistory";
import type { CountEntry, CountSession, Location } from "./types";

const locations: Location[] = [1, 2].map((n) => ({
  id: `office-1:loc-${n}`,
  officeId: "office-1",
  number: n,
  name: `Rek ${n}`,
  active: true,
}));

function makeSession(overrides: Partial<CountSession>): CountSession {
  return {
    id: "session-1",
    officeId: "office-1",
    type: "MONTHLY",
    status: "COMPLETED",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:00.000Z",
    sourceFileName: "test.xlsx",
    sourceBaseDate: "2026-08-01",
    articleIds: ["office-1:M1"],
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CountEntry>): CountEntry {
  return {
    id: "entry-1",
    sessionId: "session-1",
    articleId: "office-1:M1",
    locationId: locations[0].id,
    quantity: 0,
    counted: true,
    countedAt: "2026-08-01T00:00:00.000Z",
    note: null,
    resolution: "COUNTED",
    ...overrides,
  };
}

describe("buildArticleHistory (spec v0.2.1 §7-8)", () => {
  it("bouwt chronologisch (oudste eerst) historiek uit meerdere afgeronde sessies", () => {
    const s1 = makeSession({ id: "s1", completedAt: "2026-07-01T10:00:00.000Z" });
    const s2 = makeSession({ id: "s2", completedAt: "2026-08-01T10:00:00.000Z" });
    const entries = new Map([
      ["s1", [makeEntry({ sessionId: "s1", quantity: 9, locationId: locations[0].id })]],
      ["s2", [makeEntry({ sessionId: "s2", quantity: 7, locationId: locations[0].id })]],
    ]);
    const history = buildArticleHistory("office-1:M1", [s2, s1], entries, locations);
    expect(history.map((p) => p.sessionId)).toEqual(["s1", "s2"]);
    expect(history[0].difference).toBeNull(); // geen vorige telling om mee te vergelijken
    expect(history[1].totalCount).toBe(7);
    expect(history[1].difference).toBe(-2); // 7 - 9
  });

  it("telt over meerdere locaties heen op en toont beide locatienamen", () => {
    const session = makeSession({ id: "s1", completedAt: "2026-09-30T10:00:00.000Z" });
    const entries = new Map([
      [
        "s1",
        [
          makeEntry({ sessionId: "s1", locationId: locations[0].id, quantity: 4 }),
          makeEntry({ sessionId: "s1", id: "entry-2", locationId: locations[1].id, quantity: 3 }),
        ],
      ],
    ]);
    const history = buildArticleHistory("office-1:M1", [session], entries, locations);
    expect(history).toHaveLength(1);
    expect(history[0].totalCount).toBe(7);
    expect(history[0].locationNames).toEqual(["Rek 1", "Rek 2"]);
  });

  it("slaat een sessie over waarin het artikel niet (volledig) geteld was — geen geschatte waarde", () => {
    const s1 = makeSession({ id: "s1", completedAt: "2026-07-01T10:00:00.000Z" });
    const s2 = makeSession({ id: "s2", completedAt: "2026-08-01T10:00:00.000Z" });
    const entries = new Map([
      ["s1", [makeEntry({ sessionId: "s1", quantity: 5 })]],
      ["s2", []], // artikel had deze sessie geen enkele entry
    ]);
    const history = buildArticleHistory("office-1:M1", [s1, s2], entries, locations);
    expect(history).toHaveLength(1);
    expect(history[0].sessionId).toBe("s1");
  });

  it("neemt een expliciet-afwezig(0)-telling correct op als geldig historisch punt zonder locatie", () => {
    const session = makeSession({ id: "s1", completedAt: "2026-09-30T10:00:00.000Z" });
    const entries = new Map([
      ["s1", [makeEntry({ sessionId: "s1", locationId: null, quantity: 0, resolution: "CONFIRMED_ABSENT" })]],
    ]);
    const history = buildArticleHistory("office-1:M1", [session], entries, locations);
    expect(history).toHaveLength(1);
    expect(history[0].totalCount).toBe(0);
    expect(history[0].locationNames).toEqual([]);
  });

  it("negeert een niet-afgeronde sessie", () => {
    const activeSession = makeSession({ id: "s1", status: "ACTIVE", completedAt: null });
    const entries = new Map([["s1", [makeEntry({ sessionId: "s1", quantity: 5 })]]]);
    const history = buildArticleHistory("office-1:M1", [activeSession], entries, locations);
    expect(history).toHaveLength(0);
  });
});
