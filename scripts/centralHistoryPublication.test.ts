import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { produceDeviceAExport } from "../test-support/exportFlow";
import { loadFixtureBuffer } from "../test-support/exportFlow";
import { parseCentralHistoryFile, serializeCentralHistoryFile } from "../src/domain/centralHistoryFile";
import { buildPublication, deriveCentralSessionId } from "./centralHistoryPublication";

/** Verwijdert de kolom "Sessie-ID" uit HISTORIE: simuleert een export van vóór v0.9. */
function stripSessionIds(buffer: ArrayBuffer): ArrayBuffer {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets.HISTORIE;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  const column = (rows[0] as unknown[]).indexOf("Sessie-ID");
  expect(column).toBeGreaterThanOrEqual(0);
  const stripped = rows.map((row, index) => row.map((cell, i) => (i === column ? (index === 0 ? cell : "") : cell)));
  workbook.Sheets.HISTORIE = XLSX.utils.aoa_to_sheet(stripped);
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("buildPublication (publish-script)", () => {
  it("bouwt uit een echte export een geldig, deterministisch centraal bestand met stabiel sessie-ID", async () => {
    const { session, exported } = await produceDeviceAExport("Stocktelling_Lokeren_standaard.xlsx", "lokeren");
    const publication = await buildPublication({
      buffer: exported.data,
      fileName: exported.fileName,
      existing: null,
      generatedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(publication.file.officeId).toBe("lokeren");
    expect(publication.stats.sessionCount).toBe(1);
    expect(publication.stats.derivedSessionIds).toBe(0);
    expect(new Set(publication.file.entries.map((e) => e.sourceSessionId))).toEqual(new Set([session.id]));

    const text = serializeCentralHistoryFile(publication.file);
    expect(parseCentralHistoryFile(JSON.parse(text), "lokeren").entries).toHaveLength(publication.file.entries.length);
    // Dezelfde input twee keer = dezelfde bytes (kleine git-diffs).
    const again = await buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: null, generatedAt: "2026-10-01T12:00:00.000Z" });
    expect(serializeCentralHistoryFile(again.file)).toBe(text);
  });

  it("leidt voor een oudere export zonder Sessie-ID een deterministisch ID af", async () => {
    const { exported } = await produceDeviceAExport("Stocktelling_Lokeren_standaard.xlsx", "lokeren");
    const old = stripSessionIds(exported.data);
    const run = () => buildPublication({ buffer: old, fileName: "oud.xlsx", existing: null, generatedAt: "2026-10-01T00:00:00.000Z" });
    const first = await run();
    expect(first.stats.derivedSessionIds).toBe(first.stats.totalEntries);
    const ids = new Set(first.file.entries.map((e) => e.sourceSessionId));
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(id).toBe(deriveCentralSessionId("lokeren", first.file.entries[0].sessionName));
    expect((await run()).file.entries[0].sourceSessionId).toBe(id);
  });

  it("publiceren is additief: een bestaande publicatie blijft behouden en een gepubliceerd sessie-ID wijzigt nooit", async () => {
    const { exported } = await produceDeviceAExport("Stocktelling_Lokeren_standaard.xlsx", "lokeren");
    const first = await buildPublication({ buffer: stripSessionIds(exported.data), fileName: "oud.xlsx", existing: null, generatedAt: "2026-10-01T00:00:00.000Z" });
    const publishedId = first.file.entries[0].sourceSessionId;

    // Latere export van dezelfde sessie MET een echt id → ID blijft het eerder gepubliceerde.
    const second = await buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: first.file, generatedAt: "2026-10-02T00:00:00.000Z" });
    expect(second.stats.addedEntries).toBe(0);
    expect(new Set(second.file.entries.map((e) => e.sourceSessionId))).toEqual(new Set([publishedId]));
    expect(second.file.generatedAt).toBe("2026-10-02T00:00:00.000Z");
  });

  it("weigert een bestand zonder historiek en een ander kantoor dan het bestaande bestand", async () => {
    await expect(
      buildPublication({ buffer: loadFixtureBuffer("Stocktelling_Damme_standaard.xlsx"), fileName: "Damme.xlsx", existing: null, generatedAt: "2026-10-01T00:00:00.000Z" }),
    ).rejects.toThrow(/geen telhistoriek/);

    const { exported } = await produceDeviceAExport("Stocktelling_Lokeren_standaard.xlsx", "lokeren");
    const lokeren = await buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: null, generatedAt: "2026-10-01T00:00:00.000Z" });
    await expect(
      buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: { ...lokeren.file, officeId: "damme" }, generatedAt: "2026-10-01T00:00:00.000Z" }),
    ).rejects.toThrow(/hoort bij "damme"/);
  });

  it("--replace herbouwt volledig uit enkel de Excel (negeert het bestaande bestand)", async () => {
    const { exported } = await produceDeviceAExport("Stocktelling_Lokeren_standaard.xlsx", "lokeren");
    const first = await buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: null, generatedAt: "2026-10-01T00:00:00.000Z" });
    const withExtra = { ...first.file, entries: [...first.file.entries, { ...first.file.entries[0], sessionName: "1999-01 Maand", sourceSessionId: "oud" }] };
    const replaced = await buildPublication({ buffer: exported.data, fileName: exported.fileName, existing: withExtra, replace: true, generatedAt: "2026-10-03T00:00:00.000Z" });
    expect(replaced.file.entries.some((e) => e.sessionName === "1999-01 Maand")).toBe(false);
  });
});
