import { describe, expect, it } from "vitest";
import {
  applyAssortmentActive,
  computeAssortmentImportDiff,
  isArticleActiveInAssortment,
} from "./articleAssortment";
import type { Article } from "./types";

function makeArticle(overrides: Partial<Article> & Pick<Article, "id" | "officeId" | "articleNumber">): Article {
  return {
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
    productGroup: null,
    supplier: null,
    unit: null,
    costPrice: null,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: null,
    sourceRow: null,
    ...overrides,
  };
}

describe("isArticleActiveInAssortment (Sprint 3.3 §1)", () => {
  it("is actief wanneer het veld ontbreekt (backward compat, elk artikel van vóór deze sprint)", () => {
    expect(isArticleActiveInAssortment(makeArticle({ id: "a:1", officeId: "a", articleNumber: "1" }))).toBe(true);
  });

  it("respecteert een expliciete true/false", () => {
    expect(
      isArticleActiveInAssortment(
        makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", assortmentActive: true }),
      ),
    ).toBe(true);
    expect(
      isArticleActiveInAssortment(
        makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", assortmentActive: false }),
      ),
    ).toBe(false);
  });
});

describe("applyAssortmentActive (bulk office reassignment, Artikels-overzicht)", () => {
  it("wijzigt enkel de geselecteerde artikelen, de rest blijft ongewijzigd (niet in het resultaat)", () => {
    const a1 = makeArticle({ id: "a:1", officeId: "a", articleNumber: "1" });
    const a2 = makeArticle({ id: "a:2", officeId: "a", articleNumber: "2" });
    const a3 = makeArticle({ id: "a:3", officeId: "a", articleNumber: "3" });
    const result = applyAssortmentActive([a1, a2, a3], new Set(["a:1", "a:3"]), false);
    expect(result.map((a) => a.id).sort()).toEqual(["a:1", "a:3"]);
    expect(result.every((a) => a.assortmentActive === false)).toBe(true);
  });

  it("kan ook terug actief maken (bulk 'Actief in assortiment')", () => {
    const a1 = makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", assortmentActive: false });
    const result = applyAssortmentActive([a1], new Set(["a:1"]), true);
    expect(result[0].assortmentActive).toBe(true);
  });

  it("is puur — muteert de invoerarray niet", () => {
    const a1 = makeArticle({ id: "a:1", officeId: "a", articleNumber: "1" });
    applyAssortmentActive([a1], new Set(["a:1"]), false);
    expect(a1.assortmentActive).toBeUndefined();
  });
});

describe("computeAssortmentImportDiff (Sprint 3.3 §1: import-bootstrap/migratieregel)", () => {
  it("markeert een eerder gekend artikel dat niet meer in de nieuwe import zit als inactief, met behoud van de rest van zijn gegevens", () => {
    const previous = [
      makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", description: "Blijft" }),
      makeArticle({ id: "a:2", officeId: "a", articleNumber: "2", description: "Verdwijnt uit master" }),
    ];
    const incoming = [makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", description: "Blijft (bijgewerkt)" })];

    const { incomingArticles, newlyInactiveArticles } = computeAssortmentImportDiff(previous, incoming);

    expect(incomingArticles).toHaveLength(1);
    expect(incomingArticles[0].assortmentActive).toBe(true);
    expect(incomingArticles[0].description).toBe("Blijft (bijgewerkt)");

    expect(newlyInactiveArticles).toHaveLength(1);
    expect(newlyInactiveArticles[0].id).toBe("a:2");
    expect(newlyInactiveArticles[0].assortmentActive).toBe(false);
    // Blijft historisch/inhoudelijk ongewijzigd — enkel de assortimentsvlag wijzigt.
    expect(newlyInactiveArticles[0].description).toBe("Verdwijnt uit master");
  });

  it("laat een reeds inactief artikel dat nog steeds ontbreekt met rust (geen onnodige herschrijving)", () => {
    const previous = [
      makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", assortmentActive: false }),
    ];
    const { newlyInactiveArticles } = computeAssortmentImportDiff(previous, []);
    expect(newlyInactiveArticles).toHaveLength(0);
  });

  it("is een no-op voor een herimport van een eigen export (ARTIKEL bevat per constructie alles, actief én al-inactief)", () => {
    const previous = [
      makeArticle({ id: "a:1", officeId: "a", articleNumber: "1", assortmentActive: true }),
      makeArticle({ id: "a:2", officeId: "a", articleNumber: "2", assortmentActive: false }),
    ];
    // Een eigen export bevat exact dezelfde twee artikelen, met hun waarde
    // voor de "Assortiment actief"-kolom expliciet meegegeven (zie
    // parseArtikel.ts) — dus geen enkele wordt hier als "ontbrekend" gezien.
    const incoming = previous.map((a) => ({ ...a }));
    const { newlyInactiveArticles, incomingArticles } = computeAssortmentImportDiff(previous, incoming);
    expect(newlyInactiveArticles).toHaveLength(0);
    expect(incomingArticles.find((a) => a.id === "a:2")?.assortmentActive).toBe(false);
    expect(incomingArticles.find((a) => a.id === "a:1")?.assortmentActive).toBe(true);
  });

  it("laat een gloednieuw kantoor (geen eerder gekende artikelen) alle artikelen gewoon actief maken", () => {
    const incoming = [makeArticle({ id: "a:1", officeId: "a", articleNumber: "1" })];
    const { incomingArticles, newlyInactiveArticles } = computeAssortmentImportDiff([], incoming);
    expect(newlyInactiveArticles).toHaveLength(0);
    expect(incomingArticles[0].assortmentActive).toBe(true);
  });
});
