import { describe, expect, it } from "vitest";
import { buildArticleHistory, mergeArticleHistory } from "./articleHistory";
import type { StockHistoryEntry } from "./stockSnapshot";
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

  it("negeert een geannuleerde sessie (sessielogica-fix: enkel COMPLETED telt als officiële telling)", () => {
    const cancelledSession = makeSession({
      id: "s1",
      status: "CANCELLED",
      completedAt: null,
      cancelledAt: "2026-08-01T10:00:00.000Z",
    });
    // Ook al bestaan er CountEntries voor deze (geannuleerde) sessie, ze
    // mogen nooit in de officiële artikelgeschiedenis/grafiek verschijnen.
    const entries = new Map([["s1", [makeEntry({ sessionId: "s1", quantity: 12 })]]]);
    const history = buildArticleHistory("office-1:M1", [cancelledSession], entries, locations);
    expect(history).toHaveLength(0);
  });
});

function makeHistoryEntry(overrides: Partial<StockHistoryEntry> = {}): StockHistoryEntry {
  return {
    countDate: "2026-09-30",
    sessionType: "MONTHLY",
    sessionName: "2026-09 Maand",
    articleId: "office-1:M1",
    articleNumber: "M1",
    description: "Artikel M1",
    totalCount: 8,
    previousCount: 10,
    differenceQuantity: -2,
    costPrice: 2,
    differenceAmount: -4,
    status: "GETELD",
    locationNames: ["Rek 1"],
    ...overrides,
  };
}

describe("mergeArticleHistory — rollend stockarchief: artikelgrafiek uit geïmporteerde HISTORIE", () => {
  it("bouwt een grafiek/tabel op uit UITSLUITEND geïmporteerde HISTORIE (nieuw toestel, geen lokale sessies)", () => {
    const imported: StockHistoryEntry[] = [
      makeHistoryEntry({ sessionName: "2026-07 Maand", countDate: "2026-07-31", totalCount: 12, status: "OVERGENOMEN" }),
      makeHistoryEntry({ sessionName: "2026-08 Maand", countDate: "2026-08-31", totalCount: 12, status: "OVERGENOMEN" }),
      makeHistoryEntry({ sessionName: "2026-Q3 Kwartaal", countDate: "2026-09-30", totalCount: 9, status: "GETELD" }),
    ];
    const merged = mergeArticleHistory("office-1:M1", [], new Map(), imported);

    expect(merged.map((p) => p.sessionName)).toEqual(["2026-07 Maand", "2026-08 Maand", "2026-Q3 Kwartaal"]);
    expect(merged[0].difference).toBeNull();
    expect(merged[1].difference).toBe(0); // OVERGENOMEN 12 -> 12
    expect(merged[2].totalCount).toBe(9);
    expect(merged[2].difference).toBe(-3); // 9 - 12, exact het spec-voorbeeld
    expect(merged[2].status).toBe("GETELD");
  });

  it("dedupliceert op tellingnaam en geeft het LOKALE punt voorrang", () => {
    const local = [
      {
        sessionId: "s1",
        date: "2026-09-30T10:00:00.000Z",
        totalCount: 9,
        difference: null,
        locationNames: ["Rek 1"],
        costPrice: null,
      },
    ];
    const imported = [makeHistoryEntry({ sessionName: "2026-09 Maand", totalCount: 999 })];
    const merged = mergeArticleHistory(
      "office-1:M1",
      local,
      new Map([["s1", "2026-09 Maand"]]),
      imported,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].totalCount).toBe(9); // lokaal wint, niet de geïmporteerde 999
  });
});

describe("Kostprijsevolutie per artikel (Sprint 3.1)", () => {
  it("buildArticleHistory vult costPrice uit de meegegeven bevroren costPriceBySessionId-map, nooit de levende Article-kostprijs", () => {
    const s1 = makeSession({ id: "s1", completedAt: "2026-07-01T10:00:00.000Z" });
    const s2 = makeSession({ id: "s2", completedAt: "2026-08-01T10:00:00.000Z" });
    const entries = new Map([
      ["s1", [makeEntry({ sessionId: "s1", quantity: 9 })]],
      ["s2", [makeEntry({ sessionId: "s2", quantity: 9 })]],
    ]);
    // s1 heeft een bevroren prijs; s2 ontbreekt bewust in de map (bv. een
    // legacy-sessie zonder `FinalizedSessionResult`) — dat moet `null`
    // opleveren, nooit 0 of een verzonnen waarde.
    const costPriceBySessionId = new Map<string, number | null>([["s1", 12.5]]);
    const history = buildArticleHistory("office-1:M1", [s2, s1], entries, locations, costPriceBySessionId);
    expect(history.find((p) => p.sessionId === "s1")?.costPrice).toBe(12.5);
    expect(history.find((p) => p.sessionId === "s2")?.costPrice).toBeNull();
  });

  it("buildArticleHistory zonder costPriceBySessionId (backward-compatibel) levert overal costPrice: null op", () => {
    const session = makeSession({ id: "s1", completedAt: "2026-09-30T10:00:00.000Z" });
    const entries = new Map([["s1", [makeEntry({ sessionId: "s1", quantity: 4 })]]]);
    const history = buildArticleHistory("office-1:M1", [session], entries, locations);
    expect(history[0].costPrice).toBeNull();
  });

  it("mergeArticleHistory berekent prijsverschil/%/voorraadwaarde en slaat een tussenliggende ONBEKENDE prijs correct over", () => {
    const local = [
      { sessionId: "s1", date: "2026-07-01T10:00:00.000Z", totalCount: 10, difference: null, locationNames: [], costPrice: 100 },
      // Tussenliggend punt: prijs onbekend (bv. legacy) — mag de "vorige
      // betrouwbare prijs"-berekening van het volgende punt niet stilzwijgend
      // als 0 of als "geen wijziging" behandelen.
      { sessionId: "s2", date: "2026-08-01T10:00:00.000Z", totalCount: 10, difference: null, locationNames: [], costPrice: null },
      { sessionId: "s3", date: "2026-09-01T10:00:00.000Z", totalCount: 12, difference: null, locationNames: [], costPrice: 110 },
    ];
    const merged = mergeArticleHistory(
      "office-1:M1",
      local,
      new Map([
        ["s1", "2026-07 Maand"],
        ["s2", "2026-08 Maand"],
        ["s3", "2026-09 Maand"],
      ]),
      [],
    );

    expect(merged[0].priceDifference).toBeNull(); // eerste punt, geen vorige referentie
    expect(merged[0].stockValue).toBe(1000); // 10 * 100

    expect(merged[1].costPrice).toBeNull();
    expect(merged[1].priceDifference).toBeNull(); // eigen prijs onbekend
    expect(merged[1].stockValue).toBeNull(); // nooit verzinnen/opvullen

    // s3 vergelijkt met de dichtstbijzijnde EERDERE BEKENDE prijs (s1: 100), niet met het tussenliggende onbekende punt.
    expect(merged[2].priceDifference).toBe(10);
    expect(merged[2].pricePercentChange).toBeCloseTo(10, 5);
    expect(merged[2].stockValue).toBe(1320); // 12 * 110
  });

  it("v0.6.1 review-punt 1: vorige betrouwbare prijs 0 → pricePercentChange is null, nooit Infinity/NaN (priceDifference in € blijft wel gekend)", () => {
    const local = [
      { sessionId: "s1", date: "2026-07-01T10:00:00.000Z", totalCount: 5, difference: null, locationNames: [], costPrice: 0 },
      { sessionId: "s2", date: "2026-08-01T10:00:00.000Z", totalCount: 5, difference: null, locationNames: [], costPrice: 8 },
    ];
    const merged = mergeArticleHistory(
      "office-1:M1",
      local,
      new Map([
        ["s1", "2026-07 Maand"],
        ["s2", "2026-08 Maand"],
      ]),
      [],
    );
    expect(merged[1].priceDifference).toBe(8);
    expect(merged[1].pricePercentChange).toBeNull();
    expect(Number.isFinite(merged[1].pricePercentChange as number)).toBe(false);
  });

  it("een geïmporteerde StockHistoryEntry.costPrice stroomt automatisch mee (forward-compatibel met toekomstige legacy-import, spec §8)", () => {
    const imported: StockHistoryEntry[] = [
      makeHistoryEntry({ sessionName: "2026-06 Maand", countDate: "2026-06-30", totalCount: 5, costPrice: 8, status: "OVERGENOMEN" }),
      makeHistoryEntry({ sessionName: "2026-07 Maand", countDate: "2026-07-31", totalCount: 5, costPrice: 9, status: "GETELD" }),
    ];
    const merged = mergeArticleHistory("office-1:M1", [], new Map(), imported);
    expect(merged[0].costPrice).toBe(8);
    expect(merged[1].costPrice).toBe(9);
    expect(merged[1].priceDifference).toBe(1);
    expect(merged[1].stockValue).toBe(45); // 5 * 9
  });
});
