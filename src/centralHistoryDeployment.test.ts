import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deploy-/PWA-configuratietests voor de centrale historiek (security-
 * blocker): de data mag nooit als statisch, publiek bestand uitgeleverd
 * worden, het endpoint moet correct gebundeld zijn, en de service worker mag
 * `/api` nooit naar de SPA omleiden of precachen.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

describe("centrale historiek — deployment & PWA", () => {
  it("de data staat NIET in public/ (alles daar is wereldwijd leesbaar)", () => {
    const offenders = listFiles(path.join(ROOT, "public")).filter(
      (file) => /central-history|history.*\.json/i.test(path.basename(file)) || /central-history/i.test(file),
    );
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, "public", "central-history"))).toBe(false);
  });

  it("de data-map staat buiten public/ en vite kopieert ze dus nooit naar dist/", () => {
    expect(fs.existsSync(path.join(ROOT, "central-history-data"))).toBe(true);
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).not.toMatch(/publicDir/);
    expect(viteConfig).not.toContain("central-history-data");
  });

  it("vercel.json bundelt de data enkel in de beveiligde functie (includeFiles)", () => {
    const vercel = JSON.parse(read("vercel.json"));
    expect(vercel.functions["api/central-history.ts"].includeFiles).toBe("central-history-data/**");
    // Geen rewrite/redirect die de data via een ander (statisch) pad zou uitleveren.
    expect(vercel.rewrites ?? []).toEqual([]);
  });

  it("de service worker laat /api buiten de SPA-navigatiefallback en precachet geen json", () => {
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).toMatch(/navigateFallbackDenylist:\s*\[\/\^\\\/api\\\/\/\]/);
    expect(viteConfig).toMatch(/globPatterns:\s*\["\*\*\/\*\.\{js,css,html,svg,png,ico\}"\]/);
    expect(viteConfig).not.toMatch(/globPatterns:[^\n]*json/);
  });

  it("het endpoint is zelfstandig (geen relatieve imports) en faalt gesloten zonder tokens", () => {
    const api = read("api/central-history.ts");
    expect(api).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(api).toContain("CENTRAL_HISTORY_TOKENS");
    expect(api).toContain("timingSafeEqual");
  });

  it("er staan geen echte tokens/toegangscodes in de repo-configuratie", () => {
    for (const file of ["vercel.json", "package.json", "vite.config.ts", "central-history-data/README.md"]) {
      expect(read(file)).not.toMatch(/CENTRAL_HISTORY_TOKENS\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/);
    }
  });
});
