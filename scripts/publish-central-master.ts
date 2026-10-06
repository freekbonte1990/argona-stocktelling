/**
 * Publiceert de centrale, read-only MASTERDATA van één kantoor.
 *
 *   npm run publish-central-master -- <export.xlsx> [--out central-master-data] [--include-temporary] [--dry-run]
 *
 * Leest een Argona-Excelbestand (de export uit de app of het masterbestand),
 * bouwt het gevalideerde masterbestand en schrijft
 * `central-master-data/<officeId>.json`. Daarna: `git diff` nakijken, committen en
 * pushen — Vercel deployt en de functie `api/central-master.ts`
 * serveert het bestand (alleen-lezen, zonder authenticatie). Publiceren gebeurt
 * NOOIT vanuit de app zelf.
 *
 * Productgamma's worden afgestemd op de reeds gepubliceerde kantoren in dezelfde
 * map (zelfde naam = zelfde id). Is de inhoud ongewijzigd t.o.v. het reeds
 * gepubliceerde bestand, dan wordt er niets herschreven.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parseCentralMasterFile, type CentralMasterFile } from "../src/domain/centralMasterFile";
import { buildMasterPublication, serializeCentralMasterFile } from "./centralMasterPublication";

function readOthers(outDir: string, exceptOfficeId: string): CentralMasterFile[] {
  if (!existsSync(outDir)) return [];
  const others: CentralMasterFile[] = [];
  for (const name of readdirSync(outDir)) {
    if (!name.endsWith(".json") || name === `${exceptOfficeId}.json`) continue;
    others.push(parseCentralMasterFile(JSON.parse(readFileSync(join(outDir, name), "utf8"))));
  }
  return others;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a === "--dry-run" || a === "--include-temporary"));
  const outIndex = args.indexOf("--out");
  const outDir = resolve(outIndex >= 0 ? (args[outIndex + 1] ?? "") : "central-master-data");
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== outIndex + 1);
  const excelPath = positional[0];
  if (!excelPath) {
    console.error("Gebruik: npm run publish-central-master -- <export.xlsx> [--out <map>] [--include-temporary] [--dry-run]");
    process.exit(2);
  }

  const bytes = readFileSync(resolve(excelPath));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const common = { buffer, fileName: basename(excelPath), includeTemporary: flags.has("--include-temporary") };

  // Eerst het kantoor bepalen, dan de andere kantoren inlezen en echt opbouwen.
  const probe = await buildMasterPublication({ ...common, generatedAt: new Date().toISOString() });
  const officeId = probe.stats.officeId;
  const { file, stats } = await buildMasterPublication({
    ...common,
    generatedAt: new Date().toISOString(),
    otherOffices: readOthers(outDir, officeId),
  });

  console.log(`Kantoor:               ${stats.officeId}`);
  console.log(`Artikelen:             ${stats.articles}`);
  console.log(`Locaties:              ${stats.locations}`);
  console.log(`Koppelingen:           ${stats.assignments}`);
  console.log(`Productgamma's:        ${stats.categories}`);
  if (stats.temporaryExcluded > 0) {
    console.log(`TMP-artikelen weggelaten: ${stats.temporaryExcluded} (lokale uitzonderingen horen niet in de master; --include-temporary om toch op te nemen)`);
  }
  if (stats.unknownCategoryReferences > 0) {
    console.log(`Let op: ${stats.unknownCategoryReferences} artikel(en) verwezen naar een onbekend productgamma en staan nu "niet ingedeeld".`);
  }
  if (stats.categoriesAlignedWithOtherOffices > 0) {
    console.log(`Productgamma's afgestemd op andere kantoren (zelfde naam = zelfde id): ${stats.categoriesAlignedWithOtherOffices}`);
  }
  console.log(`Revision:              ${file.revision}`);

  const targetPath = join(outDir, `${officeId}.json`);
  if (existsSync(targetPath)) {
    try {
      const existing = parseCentralMasterFile(JSON.parse(readFileSync(targetPath, "utf8")), officeId);
      if (existing.revision === file.revision) {
        console.log("Ongewijzigd t.o.v. het reeds gepubliceerde bestand: er is niets herschreven.");
        return;
      }
    } catch {
      console.log("Het bestaande bestand was onleesbaar en wordt vervangen.");
    }
  }

  if (flags.has("--dry-run")) {
    console.log("Dry-run: er is niets weggeschreven.");
    return;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(targetPath, serializeCentralMasterFile(file), "utf8");
  console.log(`Geschreven: ${targetPath}`);
  console.log("Volgende stap: git diff nakijken, committen en pushen — Vercel publiceert de nieuwe versie.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
