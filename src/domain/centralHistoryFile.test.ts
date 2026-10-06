import { describe, expect, it } from "vitest";
import {
  buildCentralHistoryFile,
  centralSessionIdsOf,
  CentralHistoryFormatError,
  isCentralSessionIn,
  parseCentralHistoryFile,
  serializeCentralHistoryFile,
  type CentralHistoryStatus,
} from "./centralHistoryFile";
import { makeEntry, makeFile } from "../application/services/centralHistoryTestUtils";

describe("parseCentralHistoryFile", () => {
  it("accepteert een geldig bestand en behoudt alle regelvelden", () => {
    const entry = makeEntry({ sourceProductGroup: "KABELS", source: "APP" });
    const parsed = parseCentralHistoryFile(JSON.parse(JSON.stringify(makeFile([entry]))), "damme");
    expect(parsed.entries).toEqual([entry]);
    expect(parsed.deletedSessionIds).toEqual([]);
  });

  it("vereist schemaVersion, officeId, generatedAt en entries", () => {
    const base = JSON.parse(JSON.stringify(makeFile([makeEntry()])));
    for (const key of ["schemaVersion", "officeId", "generatedAt", "entries"]) {
      const broken = { ...base };
      delete broken[key];
      expect(() => parseCentralHistoryFile(broken)).toThrow(CentralHistoryFormatError);
    }
  });

  it("weigert een nieuwere schemaVersion met een duidelijke melding (app moet eerst updaten)", () => {
    expect(() => parseCentralHistoryFile({ ...makeFile([]), schemaVersion: 2 })).toThrow(/nieuwer/);
  });

  it("weigert een bestand van een ander kantoor", () => {
    expect(() => parseCentralHistoryFile(makeFile([], { officeId: "lokeren" }), "damme")).toThrow(/lokeren/);
  });

  it("weigert een regel met ongeldige datum, status, type of getal (alles-of-niets)", () => {
    const bad = (patch: object) => ({ ...makeFile([makeEntry()]), entries: [{ ...makeEntry(), ...patch }] });
    expect(() => parseCentralHistoryFile(bad({ countDate: "31/08/2026" }))).toThrow(/countDate/);
    expect(() => parseCentralHistoryFile(bad({ status: "RARE" }))).toThrow(/status/);
    expect(() => parseCentralHistoryFile(bad({ sessionType: "WEEKLY" }))).toThrow(/sessionType/);
    expect(() => parseCentralHistoryFile(bad({ totalCount: "10" }))).toThrow(/totalCount/);
    expect(() => parseCentralHistoryFile(bad({ costPrice: Number.NaN }))).toThrow(/costPrice/);
  });

  it("negeert onbekende extra velden (forward-compat binnen dezelfde schemaVersion)", () => {
    const raw = { ...makeFile([makeEntry()]), extra: 1, entries: [{ ...makeEntry(), future: true }] };
    expect(parseCentralHistoryFile(raw).entries[0]).not.toHaveProperty("future");
  });

  it("parset deletedSessionIds (tombstones) maar vereist een lijst van tekst", () => {
    expect(parseCentralHistoryFile(makeFile([], { deletedSessionIds: ["x"] })).deletedSessionIds).toEqual(["x"]);
    expect(() => parseCentralHistoryFile({ ...makeFile([]), deletedSessionIds: [1] })).toThrow(/deletedSessionIds/);
  });
});

describe("buildCentralHistoryFile / serializeCentralHistoryFile", () => {
  it("sorteert deterministisch en serialiseert naar exact dezelfde bytes bij dezelfde input", () => {
    const a = makeEntry({ articleId: "damme:B", articleNumber: "B" });
    const b = makeEntry({ articleId: "damme:A", articleNumber: "A" });
    const one = serializeCentralHistoryFile(
      buildCentralHistoryFile({ officeId: "damme", generatedAt: "2026-10-01T00:00:00.000Z", entries: [a, b] }),
    );
    const two = serializeCentralHistoryFile(
      buildCentralHistoryFile({ officeId: "damme", generatedAt: "2026-10-01T00:00:00.000Z", entries: [b, a] }),
    );
    expect(one).toBe(two);
    expect(parseCentralHistoryFile(JSON.parse(one)).entries.map((e) => e.articleId)).toEqual(["damme:A", "damme:B"]);
    // Eén regel per entry: kleine git-diffs.
    expect(one.split("\n").filter((l) => l.startsWith("    {"))).toHaveLength(2);
  });

  it("serialiseert een leeg bestand als geldige JSON", () => {
    const text = serializeCentralHistoryFile(buildCentralHistoryFile({ officeId: "damme", generatedAt: "2026-10-01T00:00:00.000Z", entries: [] }));
    expect(parseCentralHistoryFile(JSON.parse(text)).entries).toEqual([]);
  });
});

describe("centralSessionIdsOf / isCentralSessionIn", () => {
  it("telt enkel app-sessie-ID's, nooit legacy-regels", () => {
    const ids = centralSessionIdsOf([
      makeEntry({ sourceSessionId: "s1" }),
      makeEntry({ sourceSessionId: "s1", articleId: "damme:A2" }),
      makeEntry({ source: "LEGACY_IMPORT", status: "LEGACY", sourceSessionId: undefined }),
    ]);
    expect(ids).toEqual(["s1"]);
  });

  it("herkent een centrale sessie op id, of — zwakker — op snapshotnaam", () => {
    const status: CentralHistoryStatus = {
      officeId: "damme",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastGeneratedAt: null,
      lastAddedSessionCount: 0,
      centralSessionIds: ["s1"],
      centralSessionNames: ["2026-08 Maand"],
    };
    const base = { type: "MONTHLY" as const, startedAt: "2026-08-31T10:00:00.000Z", completedAt: "2026-08-31T10:00:00.000Z" };
    expect(isCentralSessionIn(status, { ...base, id: "s1" })).toBe(true);
    expect(isCentralSessionIn(status, { ...base, id: "andere" })).toBe(true); // zelfde naam 2026-08 Maand
    expect(isCentralSessionIn(status, { ...base, id: "andere", completedAt: "2026-06-20T10:00:00.000Z" })).toBe(false);
    expect(isCentralSessionIn(undefined, { ...base, id: "s1" })).toBe(false);
  });
});
