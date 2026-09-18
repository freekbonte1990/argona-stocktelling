import { describe, expect, it } from "vitest";
import { buildExportFileName } from "./exportFileName";

describe("buildExportFileName", () => {
  it("formatteert zoals de spec voorbeeldnaam (spec v0.2 §6)", () => {
    expect(buildExportFileName("Lokeren", new Date(2026, 8, 30))).toBe(
      "2026-09-30 - Stocktelling Lokeren.xlsx",
    );
  });

  it("padt maand en dag met een voorloopnul", () => {
    expect(buildExportFileName("Damme", new Date(2026, 0, 5))).toBe(
      "2026-01-05 - Stocktelling Damme.xlsx",
    );
  });
});
