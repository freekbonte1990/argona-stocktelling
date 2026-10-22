/**
 *   npx tsx scripts/apply-central-corrections.ts <correcties-*.json> [--dry-run]
 * Past het geëxporteerde correctiebestand toe op central-history-data/<kantoor>.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyCorrectionsToCentralHistory,
  parseCentralHistoryFile,
  parseCorrectionExport,
  serializeCentralHistoryFile,
} from "./applyCentralCorrections";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("Gebruik: tsx scripts/apply-central-corrections.ts <correcties.json> [--dry-run]");
  process.exit(2);
}
const correction = parseCorrectionExport(JSON.parse(readFileSync(resolve(file), "utf8")));
const target = resolve("central-history-data", `${correction.officeId}.json`);
const history = parseCentralHistoryFile(JSON.parse(readFileSync(target, "utf8")), correction.officeId);
const result = applyCorrectionsToCentralHistory(history, correction, new Date().toISOString());
console.log(JSON.stringify(result.report, null, 2));
if (!flags.includes("--dry-run") && result.report.applied.length > 0) {
  writeFileSync(target, serializeCentralHistoryFile(result.history), "utf8");
  console.log("Geschreven.");
}
