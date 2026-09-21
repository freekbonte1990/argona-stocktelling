import { describe, expect, it } from "vitest";
import { deriveOfficeCode, generateTempArticleNumber } from "./tempArticleNumber";

describe("deriveOfficeCode", () => {
  it("neemt de eerste 3 letters, hoofdletters, zonder diacritics", () => {
    expect(deriveOfficeCode("Antwerpen")).toBe("ANT");
    expect(deriveOfficeCode("Lokeren")).toBe("LOK");
    expect(deriveOfficeCode("Damme")).toBe("DAM");
  });

  it("valt terug op OFF bij een naam zonder letters", () => {
    expect(deriveOfficeCode("123")).toBe("OFF");
  });
});

describe("generateTempArticleNumber (v0.2.1 correctieronde §3)", () => {
  it("start bij 0001 wanneer er nog geen tijdelijke artikelen zijn", () => {
    expect(generateTempArticleNumber("Damme", [])).toBe("TMP-DAM-0001");
  });

  it("telt verder vanaf het hoogste bestaande volgnummer voor deze kantoorcode", () => {
    const existing = [{ articleNumber: "TMP-DAM-0001" }, { articleNumber: "TMP-DAM-0005" }];
    expect(generateTempArticleNumber("Damme", existing)).toBe("TMP-DAM-0006");
  });

  it("dupliceert nooit een reeds bestaand tijdelijk nummer, ook niet met gaten", () => {
    const existing = [{ articleNumber: "TMP-DAM-0002" }];
    const generated = generateTempArticleNumber("Damme", existing);
    expect(generated).not.toBe("TMP-DAM-0002");
    expect(generated).toBe("TMP-DAM-0003");
  });

  it("negeert officiële/andere artikelnummers en tijdelijke nummers van een andere kantoorcode", () => {
    const existing = [
      { articleNumber: "A1234" },
      { articleNumber: "TMP-ANT-0009" }, // andere kantoorcode, mag geen invloed hebben
    ];
    expect(generateTempArticleNumber("Damme", existing)).toBe("TMP-DAM-0001");
  });

  it("Antwerpen, Lokeren en Damme blijven onafhankelijk van elkaar genummerd", () => {
    const antwerpenArticles = [{ articleNumber: "TMP-ANT-0003" }];
    const lokerenArticles = [{ articleNumber: "TMP-LOK-0001" }];
    const dammeArticles: { articleNumber: string }[] = [];
    expect(generateTempArticleNumber("Antwerpen", antwerpenArticles)).toBe("TMP-ANT-0004");
    expect(generateTempArticleNumber("Lokeren", lokerenArticles)).toBe("TMP-LOK-0002");
    expect(generateTempArticleNumber("Damme", dammeArticles)).toBe("TMP-DAM-0001");
  });

  it("padt volgnummers groter dan 9999 correct zonder afkapping", () => {
    const existing = [{ articleNumber: "TMP-DAM-9999" }];
    expect(generateTempArticleNumber("Damme", existing)).toBe("TMP-DAM-10000");
  });
});
