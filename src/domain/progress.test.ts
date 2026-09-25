import { describe, expect, it } from "vitest";
import { computeSessionProgress, isArticleFullyCounted } from "./progress";
import type { CountEntry, Location } from "./types";

const locations: Location[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `loc-${n}`,
  officeId: "office",
  number: n,
  name: `Locatie ${n}`,
  active: true,
}));

function entry(overrides: Partial<CountEntry>): CountEntry {
  return {
    id: overrides.id ?? "e",
    sessionId: "s1",
    articleId: "a1",
    locationId: "loc-1",
    quantity: null,
    counted: false,
    countedAt: null,
    note: null,
    resolution: "COUNTED",
    ...overrides,
  };
}

describe("computeSessionProgress — telling-semantiek", () => {
  it("quantity=0 & counted=true is een geldig geteld resultaat", () => {
    const entries = [entry({ id: "e1", articleId: "a1", locationId: "loc-1", quantity: 0, counted: true })];
    const progress = computeSessionProgress(["a1"], locations, entries);
    expect(progress.completedUniqueArticles).toBe(1);
    expect(progress.countedLocationEntries).toBe(1);
  });

  it("quantity=null & counted=false betekent nog niet geteld", () => {
    const entries = [entry({ id: "e1", articleId: "a1", locationId: "loc-1", quantity: null, counted: false })];
    const progress = computeSessionProgress(["a1"], locations, entries);
    expect(progress.completedUniqueArticles).toBe(0);
    expect(progress.countedLocationEntries).toBe(0);
  });

  it("een artikel zonder enige entry telt niet mee als afgewerkt", () => {
    const progress = computeSessionProgress(["a1"], locations, []);
    expect(progress.completedUniqueArticles).toBe(0);
    expect(progress.totalUniqueArticles).toBe(1);
  });
});

describe("computeSessionProgress — artikel op meerdere locaties (niet naïef optellen)", () => {
  it("een artikel is pas afgewerkt als het op ALLE gekende locaties geteld is", () => {
    const entries = [
      entry({ id: "e1", articleId: "a1", locationId: "loc-1", quantity: 3, counted: true }),
      entry({ id: "e2", articleId: "a1", locationId: "loc-2", quantity: null, counted: false }),
    ];
    const progress = computeSessionProgress(["a1"], locations, entries);
    expect(progress.completedUniqueArticles).toBe(0);
    expect(progress.totalLocationEntries).toBe(2);
    expect(progress.countedLocationEntries).toBe(1);
  });

  it("wordt afgewerkt zodra alle locatie-entries van dat artikel geteld zijn", () => {
    const entries = [
      entry({ id: "e1", articleId: "a1", locationId: "loc-1", quantity: 3, counted: true }),
      entry({ id: "e2", articleId: "a1", locationId: "loc-2", quantity: 5, counted: true }),
    ];
    const progress = computeSessionProgress(["a1"], locations, entries);
    expect(progress.completedUniqueArticles).toBe(1);
  });

  it("locatie-entry voortgang kan een artikel dubbel meetellen, unieke-artikel voortgang niet", () => {
    const entries = [
      entry({ id: "e1", articleId: "a1", locationId: "loc-1", quantity: 1, counted: true }),
      entry({ id: "e2", articleId: "a1", locationId: "loc-2", quantity: 2, counted: true }),
    ];
    const progress = computeSessionProgress(["a1"], locations, entries);
    expect(progress.totalLocationEntries).toBe(2);
    expect(progress.totalUniqueArticles).toBe(1);
    expect(progress.completedUniqueArticles).toBe(1);
  });
});

describe("isArticleFullyCounted — CONFIRMED_ABSENT lost resterende stub-entries op (production-pilot-readiness sprint punt 3)", () => {
  it("geen entries -> niet volledig geteld", () => {
    expect(isArticleFullyCounted(undefined)).toBe(false);
    expect(isArticleFullyCounted([])).toBe(false);
  });

  it("enkel niet-getelde stub-entries -> niet volledig geteld", () => {
    const entries = [
      entry({ id: "e1", locationId: "loc-1", quantity: null, counted: false }),
      entry({ id: "e2", locationId: "loc-2", quantity: null, counted: false }),
    ];
    expect(isArticleFullyCounted(entries)).toBe(false);
  });

  it("alle entries counted:true -> volledig geteld (geen regressie)", () => {
    const entries = [
      entry({ id: "e1", locationId: "loc-1", quantity: 3, counted: true }),
      entry({ id: "e2", locationId: "loc-2", quantity: 1, counted: true }),
    ];
    expect(isArticleFullyCounted(entries)).toBe(true);
  });

  it("een CONFIRMED_ABSENT-entry maakt het artikel volledig geteld, ook met resterende niet-getelde stub-entries op andere locaties", () => {
    const entries = [
      entry({ id: "e1", locationId: "loc-1", quantity: null, counted: false }),
      entry({ id: "e2", locationId: "loc-2", quantity: null, counted: false }),
      entry({ id: "e3", locationId: null, quantity: 0, counted: true, resolution: "CONFIRMED_ABSENT" }),
    ];
    expect(isArticleFullyCounted(entries)).toBe(true);
  });

  it("een CONFIRMED_ABSENT-entry die zelf niet counted is (zou niet mogen voorkomen) telt niet als opgelost", () => {
    const entries = [
      entry({ id: "e1", locationId: "loc-1", quantity: null, counted: false }),
      entry({ id: "e2", locationId: null, quantity: null, counted: false, resolution: "CONFIRMED_ABSENT" }),
    ];
    expect(isArticleFullyCounted(entries)).toBe(false);
  });
});
