/**
 * Publiceert de centrale, read-only historiek van één kantoor.
 *
 *   npm run publish-central-history -- <rollend-export.xlsx> [--out central-history-data] [--replace] [--dry-run]
 *
 * Leest een Argona-Excelbestand (de export uit de app, mét HISTORIE-sheet),
 * voegt het ADDITIEF samen met het reeds gepubliceerde bestand en schrijft
 * `central-history-data/<officeId>.json`. Daarna: `git diff` nakijken,
 * committen en pushen — Vercel deployt en de beveiligde functie
 * `api/central-history.ts` serveert het nieuwe bestand (enkel met geldige
 * toegangscode). Publiceren gebeurt NOOIT vanuit de app zelf.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseCentralHistoryFile, serializeCentralHistoryFile } from "../src/domain/centralHistoryFile";
import { buildPublication } from "./centralHistoryPublication";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a === "--replace" || a === "--dry-run"));
  const outIndex = args.indexOf("--out");
  const outDir = resolve(outIndex >= 0 ? (args[outIndex + 1] ?? "") : "central-history-data");
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== outIndex + 1);
  const excelPath = positional[0];
  if (!excelPath) {
    console.error("Gebruik: npm run publish-central-history -- <export.xlsx> [--out <map>] [--replace] [--dry-run]");
    process.exit(2);
  }

  const bytes = readFileSync(resolve(excelPath));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  // Eerst het kantoor bepalen (via een droge opbouw zonder bestaand bestand),
  // daarna het bestaande bestand van dat kantoor inlezen en echt samenvoegen.
  const probe = await buildPublication({
    buffer,
    fileName: basename(excelPath),
    existing: null,
    replace: true,
    generatedAt: new Date().toISOString(),
  });
  const targetPath = join(outDir, `${probe.stats.officeId}.json`);
  const existing =
    !flags.has("--replace") && existsSync(targetPath)
      ? parseCentralHistoryFile(JSON.parse(readFileSync(targetPath, "utf8")), probe.stats.officeId)
      : null;

  const { file, stats } = await buildPublication({
    buffer,
    fileName: basename(excelPath),
    existing,
    replace: flags.has("--replace"),
    generatedAt: new Date().toISOString(),
  });

  console.log(`Kantoor:            ${stats.officeId}`);
  console.log(`Sessies (app):      ${stats.sessionCount}`);
  console.log(`Legacy-periodes:    ${stats.legacyPeriodCount}`);
  console.log(`Regels totaal:      ${stats.totalEntries} (waarvan ${stats.addedEntries} nieuw t.o.v. vorige publicatie)`);
  if (stats.derivedSessionIds > 0) {
    console.log(`Afgeleide sessie-ID's voor ${stats.derivedSessionIds} regels zonder sourceSessionId.`);
  }

  if (flags.has("--dry-run")) {
    console.log("Dry-run: er is niets weggeschreven.");
    return;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(targetPath, serializeCentralHistoryFile(file), "utf8");
  console.log(`Geschreven: ${targetPath}`);
  console.log("Volgende stap: git diff nakijken, committen en pushen — Vercel publiceert de nieuwe versie.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
