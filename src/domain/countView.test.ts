import { describe, expect, it } from "vitest";
import { defaultCountFilter, findNextTodoItem, matchesCountFilter } from "./countView";

describe("defaultCountFilter (v0.3 §3)", () => {
  it("kiest 'ALL' (brede browse-flow) tijdens leermodus", () => {
    expect(defaultCountFilter(true)).toBe("ALL");
  });

  it("kiest 'TODO' (Nog te tellen) bij een normale telling met gekende assignments", () => {
    expect(defaultCountFilter(false)).toBe("TODO");
  });
});

describe("matchesCountFilter", () => {
  it("TODO toont enkel artikelen die hier nog niet geteld zijn", () => {
    expect(matchesCountFilter("TODO", false, true)).toBe(true);
    expect(matchesCountFilter("TODO", true, true)).toBe(false);
  });

  it("DONE toont enkel artikelen die hier al geteld zijn", () => {
    expect(matchesCountFilter("DONE", true, false)).toBe(true);
    expect(matchesCountFilter("DONE", false, false)).toBe(false);
  });

  it("ALL toont altijd alles, ongeacht status", () => {
    expect(matchesCountFilter("ALL", true, true)).toBe(true);
    expect(matchesCountFilter("ALL", false, false)).toBe(true);
  });

  it("NOT_COUNTED_ANYWHERE (bestaand v0.2.1-filter) blijft ongewijzigd werken", () => {
    expect(matchesCountFilter("NOT_COUNTED_ANYWHERE", true, false)).toBe(true);
    expect(matchesCountFilter("NOT_COUNTED_ANYWHERE", false, true)).toBe(false);
  });
});

describe("findNextTodoItem (v0.3 §2)", () => {
  it("kiest de eerstvolgende niet-getelde na de gegeven index", () => {
    const items = ["A1", "A2", "A3", "A4"];
    const counted = new Set(["A1", "A2"]);
    const next = findNextTodoItem(items, 0, (item) => counted.has(item));
    expect(next).toBe("A3");
  });

  it("slaat reeds getelde items over om de eerstvolgende ONGETELDE te vinden", () => {
    const items = ["A1", "A2", "A3", "A4"];
    // A2 is al geteld (bv. via een andere weg) -- A3 is de eerstvolgende die nog moet.
    const counted = new Set(["A2"]);
    const next = findNextTodoItem(items, 0, (item) => counted.has(item));
    expect(next).toBe("A3");
  });

  it("geeft undefined terug wanneer er geen volgende niet-getelde meer is (correcte eindstate)", () => {
    const items = ["A1", "A2", "A3"];
    const counted = new Set(["A1", "A2", "A3"]);
    const next = findNextTodoItem(items, 0, (item) => counted.has(item));
    expect(next).toBeUndefined();
  });

  it("geeft undefined terug wanneer het laatste item al bereikt is", () => {
    const items = ["A1", "A2"];
    const next = findNextTodoItem(items, 1, () => false);
    expect(next).toBeUndefined();
  });
});
