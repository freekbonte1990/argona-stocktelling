/**
 * Zet de bestaande centrale data (central-master-data/*.json en central-history-data/*.json) in Supabase.
 * Idempotent: opnieuw uitvoeren ververst de rijen (bv. na `npm run publish-central-history`).
 *
 *   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=<service_role key> npm run migrate-central-to-supabase
 *   (optioneel: -- --dry-run om enkel te tonen wat er zou gebeuren)
 *
 * De service-sleutel (Supabase -> Project Settings -> API -> service_role) is GEHEIM: nooit committen,
 * nooit in de app of in een VITE_-variabele zetten. Hij wordt hier enkel lokaal gebruikt.
 */
import { join } from "node:path";
import { readCentralFiles, uploadCentralFiles } from "./migrateCentralToSupabase";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const root = process.cwd();
  const rows = [
    ...(await readCentralFiles(join(root, "central-master-data"), "master")),
    ...(await readCentralFiles(join(root, "central-history-data"), "history")),
  ];
  for (const row of rows) {
    const size = Math.round(JSON.stringify(row.payload).length / 1024);
    console.log(`${row.kind.padEnd(8)} ${row.office_id.padEnd(12)} ${String(size).padStart(6)} kB  ${JSON.stringify(row.meta)}`);
  }
  if (dryRun) {
    console.log(`\nDry-run: ${rows.length} rijen zouden geüpload worden.`);
    return;
  }
  if (!url || !serviceKey) {
    console.error("\nZet SUPABASE_URL en SUPABASE_SERVICE_KEY (of gebruik --dry-run).");
    process.exit(1);
  }
  await uploadCentralFiles(rows, { url, serviceKey });
  console.log(`\nKlaar: ${rows.length} rijen in Supabase gezet.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
