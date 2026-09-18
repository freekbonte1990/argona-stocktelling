import { describe, expect, it } from "vitest";
import { toIsoDateString, toNumberOrNull, toStringOrNull } from "./excelValues";

describe("toIsoDateString", () => {
  it("zet een Date (zoals xlsx die met cellDates:true teruggeeft) om zonder tijdzoneverschuiving", () => {
    // xlsx bouwt de Date op via de lokale tijdzoneconstructor
    // (new Date(jaar, maand, dag)), niet via UTC. `.toISOString()` zou dit
    // in elke tijdzone vóór op UTC een dag laten terugschuiven (bug
    // gevonden via de echte Excelbestanden tijdens de v0.1.1-hardeningsprint
    // — zie het commentaar in excelValues.ts). Deze test moet ongeacht de
    // tijdzone van de machine die hem uitvoert slagen, want hij bouwt de
    // Date op dezelfde manier op als xlsx dat doet: lokaal.
    const date = new Date(2026, 7, 28); // 28 augustus 2026, lokale tijd
    expect(toIsoDateString(date)).toBe("2026-08-28");
  });

  it("geeft null terug voor een ongeldige Date", () => {
    expect(toIsoDateString(new Date(Number.NaN))).toBeNull();
  });

  it("geeft null terug voor null/undefined", () => {
    expect(toIsoDateString(null)).toBeNull();
    expect(toIsoDateString(undefined)).toBeNull();
  });

  it("laat een tekstwaarde ongemoeid", () => {
    expect(toIsoDateString("28-08-2026")).toBe("28-08-2026");
  });
});

describe("toNumberOrNull", () => {
  it("laat echte getallen (zoals xlsx met raw:true teruggeeft) ongemoeid", () => {
    expect(toNumberOrNull(48.16)).toBe(48.16);
    expect(toNumberOrNull(8)).toBe(8);
  });

  it("ondersteunt een komma als decimaalteken in tekstuele fallback", () => {
    expect(toNumberOrNull("12,5")).toBe(12.5);
  });

  it("geeft null terug voor leeg/ontbrekend", () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumberOrNull("")).toBeNull();
  });
});

describe("toStringOrNull", () => {
  it("trimt tekst en zet lege string om naar null", () => {
    expect(toStringOrNull("  Antwerpen  ")).toBe("Antwerpen");
    expect(toStringOrNull("")).toBeNull();
    expect(toStringOrNull("   ")).toBeNull();
  });
});
