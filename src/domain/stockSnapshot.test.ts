import { describe, expect, it } from "vitest";
import { computeSessionReview } from "./review";
import {
  buildHistoryEntriesFromSnapshot,
  buildSessionSnapshot,
  buildSnapshotAndReviewFromHistory,
  mergeHistoryEntries,
  sessionSnapshotName,
} from "./stockSnapshot";
import type { StockHistoryEntry } from "./stockSnapshot";
import type { Article, CountEntry, CountSession, Location } from "./types";

const locations: Location[] = [1, 2].map((n) => ({
  id: `office:loc-${n}`,
  officeId: "office",
  number: n,
  name: `Locatie ${n}`,
  active: true,
}));

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return {
    id: `office:${articleNumber}`,
    officeId: "office",
    articleNumber,
    officialArticleNumber: articleNumber,
    idType: "OFFICIEEL",
    description: `Artikel ${articleNumber}`,
    productGroup: "GROEP",
    supplier: null,
    unit: "STUKS",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 10,
    sourceRow: 1,
    ...overrides,
  };
}

function makeEntry(articleId: string, locationId: string | null, overrides: Partial<CountEntry> = {}): CountEntry {
  return {
    id: `session-1:${articleId}:${locationId ?? "absent"}`,
    sessionId: "session-1",
    articleId,
    locationId,
    quantity: null,
    counted: false,
    countedAt: null,
    note: null,
    resolution: "COUNTED",
    ...overrides,
  };
}

function makeSession(overrides: Partial<CountSession> = {}): CountSession {
  return {
    id: "session-1",
    officeId: "office",
    type: "MONTHLY",
    status: "COMPLETED",
    startedAt: "2026-09-01T08:00:00.000Z",
    completedAt: "2026-09-30T15:00:00.000Z",
    sourceFileName: "test.xlsx",
    sourceBaseDate: "2026-09-01",
    articleIds: ["office:A1"],
    ...overrides,
  };
}

describe("sessionSnapshotName", () => {
  it("maandtelling -> '2026-09 Maand'", () => {
    const session = makeSession({ type: "MONTHLY", completedAt: "2026-09-30T15:00:00.000Z" });
    expect(sessionSnapshotName(session)).toBe("2026-09 Maand");
  });

  it("kwartaaltelling -> '2026-Q3 Kwartaal'", () => {
    const session = makeSession({ type: "QUARTERLY", completedAt: "2026-09-15T10:00:00.000Z" });
    expect(sessionSnapshotName(session)).toBe("2026-Q3 Kwartaal");
  });

  it("jaartelling -> '2026 Jaar'", () => {
    const session = makeSession({ type: "YEARLY", completedAt: "2026-12-31T10:00:00.000Z" });
    expect(sessionSnapshotName(session)).toBe("2026 Jaar");
  });

  it("volledige/ad-hoc telling -> '2026-09 Volledig'", () => {
    const session = makeSession({ type: "FULL", completedAt: "2026-09-10T10:00:00.000Z" });
    expect(sessionSnapshotName(session)).toBe("2026-09 Volledig");
  });

  it("elke maand van het jaar krijgt de correcte kwartaalletter", () => {
    const expectations: Array<[number, number]> = [
      [1, 1],
      [3, 1],
      [4, 2],
      [6, 2],
      [7, 3],
      [9, 3],
      [10, 4],
      [12, 4],
    ];
    for (const [month, quarter] of expectations) {
      const session = makeSession({
        type: "QUARTERLY",
        completedAt: `2026-${String(month).padStart(2, "0")}-15T10:00:00.000Z`,
      });
      expect(sessionSnapshotName(session)).toBe(`2026-Q${quarter} Kwartaal`);
    }
  });
});

describe("buildSessionSnapshot — maandtelling maakt een volledige snapshot", () => {
  it("bevat ALLE artikelen van het kantoor, niet enkel de sessiescope", () => {
    const monthlyArticle = makeArticle("A1", { countPeriod: "MONTHLY", previousCount: 10 });
    const quarterlyArticle = makeArticle("Q1", {
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
      previousCount: 12,
    });
    const allArticles = [monthlyArticle, quarterlyArticle];
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 8, counted: true }),
    ];
    const review = computeSessionReview(session, allArticles, locations, entries);
    const snapshot = buildSessionSnapshot(session, allArticles, review);

    expect(snapshot.articles).toHaveLength(2);
    expect(snapshot.sessionName).toBe("2026-09 Maand");
  });

  it("out-of-scope kwartaalartikel wordt OVERGENOMEN met zijn laatst bekende telling, nooit 0", () => {
    const monthlyArticle = makeArticle("A1", { countPeriod: "MONTHLY", previousCount: 10 });
    const quarterlyArticle = makeArticle("Q1", {
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
      previousCount: 12,
    });
    const allArticles = [monthlyArticle, quarterlyArticle];
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 8, counted: true }),
    ];
    const review = computeSessionReview(session, allArticles, locations, entries);
    const snapshot = buildSessionSnapshot(session, allArticles, review);

    const q1 = snapshot.articles.find((a) => a.articleId === "office:Q1")!;
    expect(q1.status).toBe("OVERGENOMEN");
    expect(q1.totalCount).toBe(12); // NOOIT 0
    expect(q1.previousCount).toBe(12);
    expect(q1.differenceQuantity).toBe(0);
  });

  it("een fysiek geteld artikel wordt GETELD", () => {
    const article = makeArticle("A1", { previousCount: 10 });
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 8, counted: true }),
    ];
    const review = computeSessionReview(session, [article], locations, entries);
    const snapshot = buildSessionSnapshot(session, [article], review);
    const a1 = snapshot.articles.find((a) => a.articleId === "office:A1")!;
    expect(a1.status).toBe("GETELD");
    expect(a1.totalCount).toBe(8);
    expect(a1.differenceQuantity).toBe(-2);
  });

  it("een expliciete 0-bevestiging wordt '0 BEVESTIGD'", () => {
    const article = makeArticle("A1", { previousCount: 5 });
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", null, { quantity: 0, counted: true, resolution: "CONFIRMED_ABSENT" }),
    ];
    const review = computeSessionReview(session, [article], locations, entries);
    const snapshot = buildSessionSnapshot(session, [article], review);
    const a1 = snapshot.articles.find((a) => a.articleId === "office:A1")!;
    expect(a1.status).toBe("0 BEVESTIGD");
    expect(a1.totalCount).toBe(0);
  });

  /**
   * Aanvulling: "Afronden met openstaande artikels" — een artikel dat WEL in
   * de sessiescope zat (er bestaat een reviewresultaat) maar niet (volledig)
   * geteld werd, mag enkel via de uitzonderlijke afronding een snapshot
   * krijgen (de strikte afronding blokkeert dit anders altijd) en moet dan
   * status "OVERGENOMEN - NIET GETELD" krijgen — semantisch verschillend van
   * het gewone "OVERGENOMEN" hierboven (dat artikel zat nooit in scope).
   */
  it("een in-scope artikel dat niet (volledig) geteld werd, krijgt 'OVERGENOMEN - NIET GETELD' (niet het gewone OVERGENOMEN)", () => {
    const article = makeArticle("M1", { previousCount: 12, costPrice: 2 });
    // M1 zit in scope, maar heeft geen enkele entry deze sessie (net als bij
    // een uitzonderlijke afronding zonder één enkele telling voor dit artikel).
    const session = makeSession({ articleIds: ["office:M1"] });
    const review = computeSessionReview(session, [article], locations, []);
    const snapshot = buildSessionSnapshot(session, [article], review);

    const m1 = snapshot.articles.find((a) => a.articleId === "office:M1")!;
    expect(m1.status).toBe("OVERGENOMEN - NIET GETELD");
    expect(m1.status).not.toBe("OVERGENOMEN");
    expect(m1.totalCount).toBe(12); // laatst bekende geldige fysieke voorraad, NOOIT 0
    expect(m1.previousCount).toBe(12);
    expect(m1.differenceQuantity).toBe(0);
    expect(m1.differenceAmount).toBe(0);
  });

  it("'OVERGENOMEN - NIET GETELD' toont de echte (gedeeltelijke) locatiegegevens, nooit fictieve data", () => {
    const article = makeArticle("M1", { previousCount: 12 });
    const session = makeSession({ articleIds: ["office:M1"] });
    // M1 werd wel al op locatie 1 geteld, maar heeft ook nog een openstaande
    // (niet-getelde) entry op locatie 2 — dus niet fullyCounted. Geen
    // fictieve locatie mag hierbij verzonnen worden: de echte, gedeeltelijke
    // locatiedata (loc-1 wel, loc-2 nog niet) moet gewoon zichtbaar blijven.
    const entries: CountEntry[] = [
      makeEntry("office:M1", "office:loc-1", { quantity: 5, counted: true }),
      makeEntry("office:M1", "office:loc-2", { quantity: null, counted: false }),
    ];
    const review = computeSessionReview(session, [article], locations, entries);
    const snapshot = buildSessionSnapshot(session, [article], review);

    const m1 = snapshot.articles.find((a) => a.articleId === "office:M1")!;
    expect(m1.status).toBe("OVERGENOMEN - NIET GETELD");
    // De reeds echt ingevoerde locatiedata blijft zichtbaar (geen fictieve
    // data toegevoegd, maar ook niets verborgen).
    const loc1 = m1.perLocation.find((l) => l.locationId === "office:loc-1");
    expect(loc1?.quantity).toBe(5);
    expect(loc1?.counted).toBe(true);
    // Ondanks die 5 op locatie 1, telt de snapshot NIET 5 als nieuwe telling
    // (dat zou een fysieke telling faken) — de vorige voorraad wordt overgenomen.
    expect(m1.totalCount).toBe(12);
  });

  it("overgenomen voorraad wordt nooit automatisch 0 wanneer er nog geen enkele vorige telling bekend is", () => {
    const article = makeArticle("Q1", {
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
      previousCount: null,
    });
    const session = makeSession({ articleIds: [] });
    const review = computeSessionReview(session, [article], locations, []);
    const snapshot = buildSessionSnapshot(session, [article], review);
    const q1 = snapshot.articles[0];
    expect(q1.status).toBe("OVERGENOMEN");
    expect(q1.totalCount).toBeNull(); // nooit stilzwijgend 0
    expect(q1.differenceQuantity).toBeNull();
  });
});

describe("buildHistoryEntriesFromSnapshot — HISTORIE groeit met nieuwe snapshot", () => {
  it("bouwt één regel per artikel, inclusief OVERGENOMEN-artikelen", () => {
    const monthlyArticle = makeArticle("A1", { previousCount: 10 });
    const quarterlyArticle = makeArticle("Q1", {
      countPeriod: "QUARTERLY",
      rawCountPeriod: "KWARTAAL",
      previousCount: 12,
    });
    const allArticles = [monthlyArticle, quarterlyArticle];
    const session = makeSession({ articleIds: ["office:A1"] });
    const entries: CountEntry[] = [
      makeEntry("office:A1", "office:loc-1", { quantity: 8, counted: true }),
    ];
    const review = computeSessionReview(session, allArticles, locations, entries);
    const snapshot = buildSessionSnapshot(session, allArticles, review);
    const historyEntries = buildHistoryEntriesFromSnapshot(snapshot, locations);

    expect(historyEntries).toHaveLength(2);
    const a1Entry = historyEntries.find((e) => e.articleId === "office:A1")!;
    expect(a1Entry.status).toBe("GETELD");
    expect(a1Entry.sessionName).toBe("2026-09 Maand");
    expect(a1Entry.locationNames).toEqual(["Locatie 1"]);

    const q1Entry = historyEntries.find((e) => e.articleId === "office:Q1")!;
    expect(q1Entry.status).toBe("OVERGENOMEN");
    expect(q1Entry.totalCount).toBe(12);
    expect(q1Entry.locationNames).toEqual([]);
  });

  it("geeft 'OVERGENOMEN - NIET GETELD' correct door voor een in-scope, niet-geteld artikel (aanvulling)", () => {
    const article = makeArticle("M1", { previousCount: 12 });
    const session = makeSession({ articleIds: ["office:M1"] });
    const review = computeSessionReview(session, [article], locations, []);
    const snapshot = buildSessionSnapshot(session, [article], review);
    const historyEntries = buildHistoryEntriesFromSnapshot(snapshot, locations);

    const m1Entry = historyEntries.find((e) => e.articleId === "office:M1")!;
    expect(m1Entry.status).toBe("OVERGENOMEN - NIET GETELD");
    expect(m1Entry.totalCount).toBe(12);
    expect(m1Entry.differenceQuantity).toBe(0);
  });
});

describe("mergeHistoryEntries — export -> reimport -> export behoudt alle historie zonder duplicaten", () => {
  it("dedupliceert op (tellingnaam, artikel) en behoudt de nieuwste versie", () => {
    const existing = [
      {
        countDate: "2026-08-31",
        sessionType: "MONTHLY" as const,
        sessionName: "2026-08 Maand",
        articleId: "office:A1",
        articleNumber: "A1",
        description: "Artikel A1",
        totalCount: 5,
        previousCount: 4,
        differenceQuantity: 1,
        costPrice: 2,
        differenceAmount: 2,
        status: "GETELD" as const,
        locationNames: ["Locatie 1"],
      },
    ];
    const incoming = [
      {
        countDate: "2026-09-30",
        sessionType: "MONTHLY" as const,
        sessionName: "2026-09 Maand",
        articleId: "office:A1",
        articleNumber: "A1",
        description: "Artikel A1",
        totalCount: 8,
        previousCount: 5,
        differenceQuantity: 3,
        costPrice: 2,
        differenceAmount: 6,
        status: "GETELD" as const,
        locationNames: ["Locatie 1"],
      },
      // Zelfde (tellingnaam, artikel) als een 'existing' regel: incoming wint,
      // geen duplicaat.
      { ...existing[0], totalCount: 999 },
    ];
    const merged = mergeHistoryEntries(existing, incoming);
    expect(merged).toHaveLength(2);
    const augustusEntry = merged.find((e) => e.sessionName === "2026-08 Maand")!;
    expect(augustusEntry.totalCount).toBe(999); // incoming versie wint
    expect(merged.map((e) => e.sessionName)).toEqual(["2026-08 Maand", "2026-09 Maand"]);
  });
});

describe("buildSnapshotAndReviewFromHistory — makkelijk vergelijken tussen toestellen", () => {
  function makeHistoryEntry(overrides: Partial<StockHistoryEntry> = {}): StockHistoryEntry {
    return {
      countDate: "2026-09-30",
      sessionType: "MONTHLY",
      sessionName: "2026-09 Maand",
      articleId: "office:A1",
      articleNumber: "A1",
      description: "Artikel A1",
      totalCount: 8,
      previousCount: 5,
      differenceQuantity: 3,
      costPrice: 2,
      differenceAmount: 6,
      status: "GETELD",
      locationNames: ["Locatie 1"],
      ...overrides,
    };
  }

  const articlesById = new Map([
    ["office:A1", makeArticle("A1")],
    ["office:A2", makeArticle("A2")],
    ["office:A3", makeArticle("A3")],
  ]);

  it("GETELD/0 BEVESTIGD tellen mee als geteld, OVERGENOMEN nooit (noch in scope, noch in resultaten)", () => {
    const entries = [
      makeHistoryEntry({ articleId: "office:A1", status: "GETELD" }),
      makeHistoryEntry({
        articleId: "office:A2",
        status: "0 BEVESTIGD",
        totalCount: 0,
        differenceQuantity: -5,
        differenceAmount: -10,
      }),
      makeHistoryEntry({
        articleId: "office:A3",
        status: "OVERGENOMEN",
        totalCount: 10,
        previousCount: 10,
        differenceQuantity: 0,
        differenceAmount: 0,
      }),
    ];

    const { snapshot, review } = buildSnapshotAndReviewFromHistory("recon-1", entries, articlesById);

    // Snapshot bevat ALTIJD alle drie (ook OVERGENOMEN) — zelfde regel als
    // een echte sessie.
    expect(snapshot.articles).toHaveLength(3);
    expect(snapshot.sessionName).toBe("2026-09 Maand");
    expect(snapshot.sessionType).toBe("MONTHLY");
    expect(snapshot.snapshotDate).toBe("2026-09-30");
    expect(snapshot.provenance).toBe("APP_COUNT");

    // Review-scope/resultaten bevatten OVERGENOMEN nooit.
    expect(review.totalArticlesInScope).toBe(2);
    expect(review.countedArticles).toBe(2);
    expect(review.notCountedArticles).toBe(0);
    expect(review.results).toHaveLength(2);
    expect(review.results.map((r) => r.articleId)).toEqual(["office:A1", "office:A2"]);
    expect(review.results.every((r) => r.isManualAddition === false)).toBe(true);
  });

  it("OVERGENOMEN - NIET GETELD komt wel in scope maar telt niet als geteld, en heeft geen entry", () => {
    const entries = [
      makeHistoryEntry({ articleId: "office:A1", status: "GETELD" }),
      makeHistoryEntry({
        articleId: "office:A2",
        status: "OVERGENOMEN - NIET GETELD",
        totalCount: 7,
        previousCount: 7,
        differenceQuantity: 0,
        differenceAmount: 0,
      }),
    ];

    const { review } = buildSnapshotAndReviewFromHistory("recon-2", entries, articlesById);

    expect(review.totalArticlesInScope).toBe(2);
    expect(review.countedArticles).toBe(1);
    expect(review.notCountedArticles).toBe(1);
    const a2 = review.results.find((r) => r.articleId === "office:A2")!;
    expect(a2.fullyCounted).toBe(false);
    expect(a2.hasAnyEntry).toBe(false);
    expect(review.notFoundAnywhere.map((r) => r.articleId)).toEqual(["office:A2"]);
  });

  it("som van verschillen/bedragen (positief/negatief apart) klopt, net als computeSessionReview", () => {
    const entries = [
      makeHistoryEntry({
        articleId: "office:A1",
        status: "GETELD",
        totalCount: 8,
        previousCount: 5,
        differenceQuantity: 3,
        differenceAmount: 6,
      }),
      makeHistoryEntry({
        articleId: "office:A2",
        status: "0 BEVESTIGD",
        totalCount: 0,
        previousCount: 5,
        differenceQuantity: -5,
        differenceAmount: -10,
      }),
    ];

    const { review } = buildSnapshotAndReviewFromHistory("recon-3", entries, articlesById);

    expect(review.articlesWithDifference).toBe(2);
    expect(review.totalPositiveCorrectionQuantity).toBe(3);
    expect(review.totalNegativeCorrectionQuantity).toBe(-5);
    expect(review.totalPositiveCorrectionAmount).toBe(6);
    expect(review.totalNegativeCorrectionAmount).toBe(-10);
  });

  it("bevriest articleNumber/description op de HISTORIE-regel, nooit het levende artikel", () => {
    const entries = [
      makeHistoryEntry({
        articleId: "office:A1",
        articleNumber: "OUD-NUMMER",
        description: "Oude omschrijving",
      }),
    ];
    const { snapshot } = buildSnapshotAndReviewFromHistory("recon-4", entries, articlesById);
    expect(snapshot.articles[0].article.articleNumber).toBe("OUD-NUMMER");
    expect(snapshot.articles[0].article.description).toBe("Oude omschrijving");
  });

  it("een ontbrekend artikel (verwijderd/nooit gekend) wordt defensief overgeslagen, geen crash", () => {
    const entries = [makeHistoryEntry({ articleId: "office:ONBEKEND" })];
    const { snapshot, review } = buildSnapshotAndReviewFromHistory("recon-5", entries, articlesById);
    expect(snapshot.articles).toHaveLength(0);
    expect(review.results).toHaveLength(0);
  });
});
