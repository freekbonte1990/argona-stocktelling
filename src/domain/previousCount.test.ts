import { describe, expect, it } from "vitest";
import { makeArticle, makeEntry } from "../application/services/centralHistoryTestUtils";
import { applyDerivedPreviousCounts, derivePreviousCountsFromHistory } from "./previousCount";

describe("derivePreviousCountsFromHistory", () => {
  it("neemt per artikel de meest recente effectieve telling", () => {
    const derived = derivePreviousCountsFromHistory([
      makeEntry({ countDate: "2026-07-31", totalCount: 3 }),
      makeEntry({ countDate: "2026-08-31", totalCount: 8 }),
      makeEntry({ countDate: "2026-06-30", totalCount: 1 }),
    ]);
    expect(derived.get("damme:A1")).toBe(8);
  });

  it("telt GETELD, '0 BEVESTIGD' en LEGACY als telling, maar OVERGENOMEN niet", () => {
    const base = { articleId: "damme:A1", articleNumber: "A1" };
    expect(derivePreviousCountsFromHistory([makeEntry({ ...base, status: "GETELD", totalCount: 5 })]).get("damme:A1")).toBe(5);
    expect(derivePreviousCountsFromHistory([makeEntry({ ...base, status: "0 BEVESTIGD", totalCount: 0 })]).get("damme:A1")).toBe(0);
    expect(derivePreviousCountsFromHistory([makeEntry({ ...base, status: "LEGACY", totalCount: 7 })]).get("damme:A1")).toBe(7);
    const overgenomen = derivePreviousCountsFromHistory([
      makeEntry({ ...base, countDate: "2026-07-31", status: "GETELD", totalCount: 4 }),
      makeEntry({ ...base, countDate: "2026-08-31", status: "OVERGENOMEN - NIET GETELD", totalCount: 9 }),
    ]);
    expect(overgenomen.get("damme:A1")).toBe(4);
  });

  it("negeert regels zonder totaal en geeft niets voor een artikel zonder telling", () => {
    const derived = derivePreviousCountsFromHistory([makeEntry({ totalCount: null })]);
    expect(derived.size).toBe(0);
  });

  it("bij gelijke datum wint de hoogste sessienaam", () => {
    const derived = derivePreviousCountsFromHistory([
      makeEntry({ countDate: "2026-08-31", sessionName: "2026-08 Maand", totalCount: 1 }),
      makeEntry({ countDate: "2026-08-31", sessionName: "2026-08 Maand (b)", totalCount: 2 }),
    ]);
    expect(derived.get("damme:A1")).toBe(2);
  });
});

describe("applyDerivedPreviousCounts", () => {
  it("geeft enkel artikelen terug waarvan previousCount effectief verandert", () => {
    const a1 = { ...makeArticle("damme", "A1"), previousCount: 3 };
    const a2 = { ...makeArticle("damme", "A2"), previousCount: 5 };
    const a3 = { ...makeArticle("damme", "A3"), previousCount: 6 };
    const changed = applyDerivedPreviousCounts(
      [a1, a2, a3],
      new Map([
        ["damme:A1", 9],
        ["damme:A2", 5],
      ]),
    );
    expect(changed.map((a) => [a.id, a.previousCount])).toEqual([["damme:A1", 9]]);
  });

  it("wist nooit een bestaande waarde wanneer de historiek niets weet", () => {
    const a3 = { ...makeArticle("damme", "A3"), previousCount: 6 };
    expect(applyDerivedPreviousCounts([a3], new Map())).toEqual([]);
  });
});
