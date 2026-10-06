import { describe, expect, it } from "vitest";
import {
  CentralMasterFormatError,
  isCentralArticle,
  isCentralCategory,
  isCentralLocation,
  isCentrallyManaged,
  isTemporaryArticle,
  parseCentralMasterFile,
  parseCentralOfficeIndex,
  type CentralMasterStatus,
} from "./centralMasterFile";
import { makeMaster, makeMasterArticle } from "../application/services/centralMasterTestUtils";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function broken(mutate: (raw: Record<string, any>) => void, expected?: string): void {
  const raw = clone(makeMaster()) as unknown as Record<string, any>;
  mutate(raw);
  expect(() => parseCentralMasterFile(raw)).toThrow(CentralMasterFormatError);
  if (expected) expect(() => parseCentralMasterFile(raw)).toThrow(expected);
}

describe("parseCentralMasterFile — strikte, alles-of-niets validatie", () => {
  it("aanvaardt een geldig bestand en geeft het ongewijzigd terug", () => {
    const master = makeMaster();
    expect(parseCentralMasterFile(clone(master), "damme")).toEqual(master);
  });

  it("weigert een bestand van een ander kantoor", () => {
    expect(() => parseCentralMasterFile(clone(makeMaster()), "lokeren")).toThrow("lokeren");
  });

  it("weigert niet-objecten en een onbekende of nieuwere schemaVersion", () => {
    expect(() => parseCentralMasterFile(null)).toThrow(CentralMasterFormatError);
    expect(() => parseCentralMasterFile([])).toThrow(CentralMasterFormatError);
    broken((r) => (r.schemaVersion = 2), "nieuwer");
    broken((r) => delete r.schemaVersion, "onbekende schemaVersion");
  });

  it("negeert onbekende extra velden (forward-compat binnen dezelfde schemaVersion)", () => {
    const raw = clone(makeMaster()) as unknown as Record<string, any>;
    raw.toekomst = { x: 1 };
    raw.articles[0].nieuwVeld = "ok";
    const parsed = parseCentralMasterFile(raw);
    expect(parsed.articles[0]).not.toHaveProperty("nieuwVeld");
  });

  it("bevat nooit tellingen: previousCount in de bron wordt niet overgenomen", () => {
    const raw = clone(makeMaster()) as unknown as Record<string, any>;
    raw.articles[0].previousCount = 99;
    expect(parseCentralMasterFile(raw).articles[0]).not.toHaveProperty("previousCount");
  });

  it.each([
    ["ontbrekende kantoornaam", (r: any) => delete r.office.name],
    ["ongeldige generatedAt", (r: any) => (r.generatedAt = "gisteren")],
    ["ongeldige revision", (r: any) => (r.revision = "a b")],
    ["locaties geen lijst", (r: any) => (r.locations = {})],
    ["dubbele locatie-id", (r: any) => r.locations.push({ ...r.locations[0], number: 9 })],
    ["locatienummer 0", (r: any) => (r.locations[0].number = 0)],
    ["geen enkele actieve locatie", (r: any) => r.locations.forEach((l: any) => (l.active = false))],
    ["dubbele categorie-id", (r: any) => r.categories.push({ ...r.categories[0], name: "Anders" })],
    ["dubbele categorienaam (hoofdletterongevoelig)", (r: any) => r.categories.push({ id: "x", name: "KABELS", sortOrder: 9, active: true })],
    ["dubbel artikelnummer", (r: any) => r.articles.push({ ...r.articles[0] })],
    ["onbekende countPeriod", (r: any) => (r.articles[0].countPeriod = "WEKELIJKS")],
    ["onbekende status", (r: any) => (r.articles[0].status = "KAPOT")],
    ["onbekende categoryId", (r: any) => (r.articles[0].categoryId = "bestaat-niet")],
    ["negatieve kostprijs", (r: any) => (r.articles[0].costPrice = -1)],
    ["kostprijs geen getal", (r: any) => (r.articles[0].costPrice = "2,5")],
    ["koppeling naar onbekend artikel", (r: any) => r.assignments.push({ articleNumber: "ZZZ", locationId: "damme:loc-1", active: true })],
    ["koppeling naar onbekende locatie", (r: any) => r.assignments.push({ articleNumber: "A1", locationId: "nergens", active: true })],
    ["dubbele koppeling", (r: any) => r.assignments.push({ ...r.assignments[0] })],
    ["ongeldige tombstones", (r: any) => (r.deletedArticleNumbers = [1])],
  ])("weigert: %s", (_name, mutate) => {
    broken(mutate as (raw: Record<string, any>) => void);
  });

  it("één slecht artikel tussen duizend goede maakt het héle bestand ongeldig (geen gedeeltelijke master)", () => {
    const articles = Array.from({ length: 1000 }, (_, i) => makeMasterArticle(`N${i}`));
    const raw = clone(makeMaster({ articles, assignments: [] })) as unknown as Record<string, any>;
    raw.articles[777].countPeriod = "???";
    expect(() => parseCentralMasterFile(raw)).toThrow("articles[777]");
  });
});

describe("parseCentralOfficeIndex", () => {
  const valid = {
    schemaVersion: 1,
    offices: [{ id: "damme", name: "Damme", revision: "rev-0001", generatedAt: "2026-10-01T12:00:00.000Z", articleCount: 528 }],
  };

  it("aanvaardt een geldige kantorenlijst", () => {
    expect(parseCentralOfficeIndex(valid).offices).toEqual(valid.offices);
  });

  it("weigert dubbele kantoren en ongeldige revisions", () => {
    expect(() => parseCentralOfficeIndex({ ...valid, offices: [valid.offices[0], valid.offices[0]] })).toThrow("dubbel");
    expect(() => parseCentralOfficeIndex({ ...valid, offices: [{ ...valid.offices[0], revision: "!" }] })).toThrow("revision");
    expect(() => parseCentralOfficeIndex({ schemaVersion: 1 })).toThrow(CentralMasterFormatError);
  });
});

describe("hulpfuncties", () => {
  const status: CentralMasterStatus = {
    officeId: "damme",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    revision: "rev-0001",
    generatedAt: null,
    appliedAt: "2026-10-01T12:00:00.000Z",
    pendingRevision: null,
    articleIds: ["damme:A1"],
    locationIds: ["damme:loc-1"],
    categoryIds: ["cat-kabels"],
    assignmentIds: [],
  };

  it("een kantoor is enkel centraal beheerd wanneer er ooit een master is toegepast", () => {
    expect(isCentrallyManaged(undefined)).toBe(false);
    expect(isCentrallyManaged({ ...status, appliedAt: null })).toBe(false);
    expect(isCentrallyManaged(status)).toBe(true);
  });

  it("centraal = beheerd én in de 'ooit centraal'-lijsten", () => {
    expect(isCentralArticle(status, "damme:A1")).toBe(true);
    expect(isCentralArticle(status, "damme:TMP-DAM-0001")).toBe(false);
    expect(isCentralLocation(status, "damme:loc-1")).toBe(true);
    expect(isCentralLocation(status, "damme:lokaal")).toBe(false);
    expect(isCentralCategory(status, "cat-kabels")).toBe(true);
    expect(isCentralArticle({ ...status, appliedAt: null }, "damme:A1")).toBe(false);
  });

  it("herkent tijdelijke TMP-artikelen op idType én op nummer", () => {
    expect(isTemporaryArticle({ idType: "TIJDELIJK", articleNumber: "X" })).toBe(true);
    expect(isTemporaryArticle({ idType: null, articleNumber: "tmp-dam-0001" })).toBe(true);
    expect(isTemporaryArticle({ idType: "OFFICIEEL", articleNumber: "A1" })).toBe(false);
  });
});
