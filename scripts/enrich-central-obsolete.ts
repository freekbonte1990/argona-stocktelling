/**
 *   npx tsx scripts/enrich-central-obsolete.ts <lokeren|damme> <legacy.xlsx> [--dry-run]
 * Zie `enrichCentralObsolete.ts`. Leest en herschrijft central-master-data/<kantoor>.json en
 * central-history-data/<kantoor>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLegacyStockDamme, parseLegacyStockLokeren } from "../src/adapters/excel/parseLegacyStock";
import {
  enrichCentralObsolete,
  parseCentralHistoryFile,
  parseCentralMasterFile,
  serializeCentralHistoryFile,
  serializeCentralMasterFile,
} from "./enrichCentralObsolete";

const [officeId, legacyPath, ...flags] = process.argv.slice(2);
if (!officeId || !legacyPath) {
  console.error("Gebruik: tsx scripts/enrich-central-obsolete.ts <lokeren|damme> <legacy.xlsx> [--dry-run]");
  process.exit(2);
}
const dir = (name: string) => resolve(name, `${officeId}.json`);
const master = parseCentralMasterFile(JSON.parse(readFileSync(dir("central-master-data"), "utf8")), officeId);
const history = parseCentralHistoryFile(JSON.parse(readFileSync(dir("central-history-data"), "utf8")), officeId);
const bytes = readFileSync(resolve(legacyPath));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const parse = officeId === "lokeren" ? parseLegacyStockLokeren : parseLegacyStockDamme;
const result = enrichCentralObsolete({
  officeId,
  master,
  history,
  legacyRows: parse(buffer, legacyPath),
  generatedAt: new Date().toISOString(),
});
console.log(JSON.stringify(result.report, null, 2));
if (!flags.includes("--dry-run")) {
  writeFileSync(dir("central-master-data"), serializeCentralMasterFile(result.master), "utf8");
  writeFileSync(dir("central-history-data"), serializeCentralHistoryFile(result.history), "utf8");
  console.log("Geschreven.");
}
