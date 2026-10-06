import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deploy-/PWA-configuratietests voor de centrale historiek: de data mag nooit als statisch, publiek bestand uitgeleverd
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

  it("vercel.json bundelt de data enkel in de functie (niet als statisch bestand) (includeFiles)", () => {
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

  it("het endpoint is zelfstandig (geen relatieve imports), alleen-lezen en niet cachebaar", () => {
    const api = read("api/central-history.ts");
    expect(api).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(api).toContain("no-store");
    expect(api).toContain("OFFICE_ID_PATTERN");
  });

  it("er is geen toegangscode-/token-/auth-logica meer in endpoints of app-code (bewuste keuze: geen auth)", () => {
    const sources = [
      ...listFiles(path.join(ROOT, "api")),
      ...listFiles(path.join(ROOT, "src")),
      ...listFiles(path.join(ROOT, "scripts")),
    ].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !/deployment/i.test(f));
    for (const file of sources) {
      const code = fs.readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/CENTRAL_HISTORY_TOKENS|timingSafeEqual|Authorization|getAccessCode|AccessCode/);
    }
    for (const file of ["vercel.json", "package.json", "vite.config.ts"]) {
      expect(read(file)).not.toMatch(/CENTRAL_HISTORY_TOKENS/);
    }
  });
});

describe("centrale masterdata — deployment & PWA (kostprijzen zijn gevoelig)", () => {
  it("de data staat NIET in public/ en vite kopieert ze nooit naar dist/", () => {
    const offenders = listFiles(path.join(ROOT, "public")).filter((file) => /central-master|master.*\.json/i.test(file));
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, "central-master-data"))).toBe(true);
    expect(read("vite.config.ts")).not.toContain("central-master-data");
  });

  it("vercel.json bundelt de master enkel in de functie (niet als statisch bestand) en behoudt die van de historiek", () => {
    const vercel = JSON.parse(read("vercel.json"));
    expect(vercel.functions["api/central-master.ts"].includeFiles).toBe("central-master-data/**");
    expect(vercel.functions["api/central-history.ts"].includeFiles).toBe("central-history-data/**");
    expect(vercel.rewrites ?? []).toEqual([]);
  });

  it("het endpoint is zelfstandig (geen relatieve imports), alleen-lezen en niet cachebaar", () => {
    const api = read("api/central-master.ts");
    expect(api).not.toMatch(/from\s+["']\.{1,2}\//);
    expect(api).toContain("no-store");
    expect(api).toContain("OFFICE_ID_PATTERN");
  });

  it("de frontend bevat geen masterdata en geen codes: de data-map wordt nergens in src/ geïmporteerd", () => {
    const offenders = listFiles(path.join(ROOT, "src")).filter(
      (file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file) && /central-master-data/.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("de gepubliceerde masters in de repo zijn geldig volgens dezelfde parser als de app", async () => {
    const { parseCentralMasterFile } = await import("./domain/centralMasterFile");
    const dir = path.join(ROOT, "central-master-data");
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      expect(() => parseCentralMasterFile(raw, name.replace(/\.json$/, ""))).not.toThrow();
    }
  });
});
