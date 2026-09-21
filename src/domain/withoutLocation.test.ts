import { describe, expect, it } from "vitest";
import { articlesWithoutLocation } from "./withoutLocation";
import type { Article, ArticleLocationAssignment, CountSession } from "./types";

/**
 * v0.2.1 correctieronde §2: "Zonder locatie" — een dynamische werklijst,
 * geen fysieke locatie. Puur domein, geen React/IndexedDB — zie
 * withoutLocation.ts voor het waarom van de sessiescope.
 */

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: null,
    description: "Omschrijving",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<ArticleLocationAssignment>): ArticleLocationAssignment {
  return {
    id: "office-1:art:loc",
    officeId: "office-1",
    articleId: "art",
    locationId: "loc-1",
    active: true,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const articleA1 = makeArticle({ articleNumber: "A1" });
const articleA2 = makeArticle({ articleNumber: "A2" });
const articleQ1 = makeArticle({ articleNumber: "Q1", countPeriod: "QUARTERLY" });

describe("articlesWithoutLocation", () => {
  it("een artikel zonder enige actieve locatiekoppeling verschijnt in de lijst", () => {
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1"] };
    const result = articlesWithoutLocation([articleA1], session, []);
    expect(result.map((a) => a.id)).toEqual(["office-1:A1"]);
  });

  it("een artikel MET een actieve locatiekoppeling verschijnt NIET", () => {
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1"] };
    const assignments = [makeAssignment({ articleId: "office-1:A1", active: true })];
    const result = articlesWithoutLocation([articleA1], session, assignments);
    expect(result).toHaveLength(0);
  });

  it("een artikel waarvan de enige koppeling INACTIEF is, telt weer als 'zonder locatie'", () => {
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1"] };
    const assignments = [makeAssignment({ articleId: "office-1:A1", active: false })];
    const result = articlesWithoutLocation([articleA1], session, assignments);
    expect(result.map((a) => a.id)).toEqual(["office-1:A1"]);
  });

  it("enkel de huidige sessiescope: een artikel buiten scope (bv. ander telfrequentie) komt niet mee, ook zonder locatie", () => {
    // Q1 is een kwartaalartikel dat niet in deze (maand)sessie zit.
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1"] };
    const result = articlesWithoutLocation([articleA1, articleQ1], session, []);
    expect(result.map((a) => a.id)).toEqual(["office-1:A1"]);
  });

  it("werkt voor een maandtelling-scope", () => {
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1", "office-1:A2"] };
    const result = articlesWithoutLocation([articleA1, articleA2], session, []);
    expect(result.map((a) => a.id).sort()).toEqual(["office-1:A1", "office-1:A2"]);
  });

  it("werkt voor een kwartaaltelling-scope (bevat ook maandartikelen)", () => {
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1", "office-1:Q1"] };
    const result = articlesWithoutLocation([articleA1, articleQ1], session, []);
    expect(result.map((a) => a.id).sort()).toEqual(["office-1:A1", "office-1:Q1"]);
  });

  it("een artikel verdwijnt onmiddellijk uit de berekening zodra het een actieve koppeling krijgt", () => {
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1"] };
    const before = articlesWithoutLocation([articleA1], session, []);
    expect(before).toHaveLength(1);

    const after = articlesWithoutLocation(
      [articleA1],
      session,
      [makeAssignment({ articleId: "office-1:A1", active: true })],
    );
    expect(after).toHaveLength(0);
  });

  it("maakt of gebruikt nergens een Location-record — puur een berekening over Article + assignments", () => {
    // Deze functie neemt geen Office/Location-parameter en heeft dus
    // structureel geen manier om een fysieke locatie aan te maken.
    const session: Pick<CountSession, "articleIds"> = { articleIds: ["office-1:A1"] };
    expect(articlesWithoutLocation.length).toBe(3); // (articles, session, assignments) — geen 4de "office"-param.
    expect(() => articlesWithoutLocation([articleA1], session, [])).not.toThrow();
  });
});
