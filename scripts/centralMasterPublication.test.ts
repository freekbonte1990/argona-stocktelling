import { describe, expect, it } from "vitest";
import { loadFixtureBuffer } from "../test-support/exportFlow";
import { parseCentralMasterFile } from "../src/domain/centralMasterFile";
import { CATEGORY_KABELS, makeMaster } from "../src/application/services/centralMasterTestUtils";
import { alignCategories, buildMasterPublication, computeMasterRevision, serializeCentralMasterFile } from "./centralMasterPublication";

const GENERATED = "2026-10-01T12:00:00.000Z";
const build = (fixture: string, extra: Record<string, unknown> = {}) =>
  buildMasterPublication({ buffer: loadFixtureBuffer(fixture), fileName: fixture, generatedAt: GENERATED, ...extra });

describe("buildMasterPublication (publish-central-master)", () => {
  it("bouwt uit een echt Argona-bestand een geldige master die door de app-parser komt", async () => {
    const { file, stats } = await build("Stocktelling_Lokeren_standaard.xlsx");
    expect(file.officeId).toBe("lokeren");
    expect(stats.articles).toBeGreaterThan(100);
    expect(stats.locations).toBeGreaterThanOrEqual(1);
    const parsed = parseCentralMasterFile(JSON.parse(serializeCentralMasterFile(file)), "lokeren");
    expect(parsed.articles).toHaveLength(stats.articles);
    expect(parsed.revision).toBe(file.revision);
  });

  it("is deterministisch: dezelfde input geeft dezelfde bytes én dezelfde revision, ook bij een ander generatedAt", async () => {
    const a = await build("Stocktelling_Lokeren_standaard.xlsx");
    const b = await build("Stocktelling_Lokeren_standaard.xlsx");
    expect(serializeCentralMasterFile(a.file)).toBe(serializeCentralMasterFile(b.file));
    const later = await build("Stocktelling_Lokeren_standaard.xlsx", { generatedAt: "2027-01-01T00:00:00.000Z" });
    expect(later.file.revision).toBe(a.file.revision);
  });

  it("de master bevat nooit tellingen, vorige tellingen of opmerkingen", async () => {
    const { file } = await build("Stocktelling_Damme_standaard.xlsx");
    const text = serializeCentralMasterFile(file);
    expect(text).not.toContain("previousCount");
    expect(text).not.toContain("comment");
    expect(text).not.toContain("sessionId");
    expect(text).not.toContain("quantity");
  });

  it("sluit lokale TMP-artikelen standaard uit (en rapporteert hoeveel), tenzij --include-temporary", async () => {
    const { file, stats } = await build("Stocktelling_Antwerpen_standaard.xlsx");
    expect(file.articles.some((a) => a.idType === "TIJDELIJK" || /^TMP-/i.test(a.articleNumber))).toBe(false);
    const withTmp = await build("Stocktelling_Antwerpen_standaard.xlsx", { includeTemporary: true });
    expect(withTmp.stats.articles).toBe(stats.articles + stats.temporaryExcluded);
  });

  it("de revision verandert enkel als de inhoud verandert", () => {
    const { generatedAt: _g, revision: _r, ...content } = makeMaster();
    const base = computeMasterRevision(content);
    expect(computeMasterRevision({ ...content })).toBe(base);
    expect(computeMasterRevision({ ...content, office: { name: "Andere naam", baseDate: null } })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stemt productgamma's af met reeds gepubliceerde kantoren: zelfde naam = zelfde id (alle kantoren delen één lijst)", async () => {
    const antwerpen = await build("Stocktelling_Antwerpen_standaard.xlsx");
    const damme = await build("Stocktelling_Damme_standaard.xlsx", { otherOffices: [antwerpen.file] });
    const byName = new Map(antwerpen.file.categories.map((c) => [c.name.toLowerCase(), c.id]));
    for (const category of damme.file.categories) {
      const published = byName.get(category.name.toLowerCase());
      if (published) expect(category.id).toBe(published);
    }
    const ids = new Set(damme.file.categories.map((c) => c.id));
    for (const article of damme.file.articles) if (article.categoryId) expect(ids.has(article.categoryId)).toBe(true);
  });
});

describe("alignCategories", () => {
  const other = makeMaster({ officeId: "antwerpen" });

  it("herleidt een lokaal id met dezelfde naam naar het reeds gepubliceerde id", () => {
    const result = alignCategories([{ id: "random-uuid", name: "kabels", sortOrder: 3, active: true }], [other]);
    expect(result.idMap.get("random-uuid")).toBe(CATEGORY_KABELS.id);
    expect(result.aligned).toBe(1);
    expect(result.categories.map((c) => c.id)).toContain(CATEGORY_KABELS.id);
    expect(result.categories.map((c) => c.id)).not.toContain("random-uuid");
  });

  it("neemt de bedrijfsbrede categorieën van andere kantoren mee", () => {
    const result = alignCategories([{ id: "eigen", name: "Eigen gamma", sortOrder: 9, active: true }], [other]);
    expect(result.categories.map((c) => c.id).sort()).toEqual(["cat-kabels", "cat-lampen", "eigen"].sort());
  });

  it("zelfde id met een andere naam is een harde conflictfout (nooit stilletjes publiceren)", () => {
    expect(() => alignCategories([{ id: "cat-kabels", name: "Iets anders", sortOrder: 1, active: true }], [other])).toThrow(
      /conflict/i,
    );
  });
});
