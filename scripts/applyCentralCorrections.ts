import { parseCentralHistoryFile, serializeCentralHistoryFile, type CentralHistoryFile } from "../src/domain/centralHistoryFile";
import type { SessionCorrectionExport } from "../src/domain/sessionCorrection";

/**
 * Past een geëxporteerd correctiebestand ("Correcties exporteren" in de app) toe op
 * `central-history-data/<kantoor>.json`, zodat nieuwe toestellen de juiste aantallen zien.
 * Enkel `totalCount`, `differenceQuantity`, `differenceAmount` en `status` van de gecorrigeerde
 * regels in die ene sessie wijzigen; sessie-ID, naam, datum en kostprijzen blijven.
 */
export interface ApplyCorrectionsReport {
  sessionName: string;
  applied: { articleNumber: string; oldTotalCount: number | null; newTotalCount: number }[];
  alreadyApplied: string[];
  notFound: string[];
  /** Waarschuwing als het centrale oude aantal niet met het gerapporteerde origineel overeenkomt. */
  mismatches: string[];
}

export function parseCorrectionExport(raw: unknown): SessionCorrectionExport {
  const r = raw as Partial<SessionCorrectionExport> | null;
  if (!r || r.kind !== "argona-session-corrections" || r.version !== 1 || !Array.isArray(r.corrections)) {
    throw new Error("Geen geldig correctiebestand (kind/version).");
  }
  for (const c of r.corrections) {
    if (typeof c.articleNumber !== "string" || typeof c.newTotalCount !== "number" || c.newTotalCount < 0) {
      throw new Error("Ongeldige correctie in het bestand.");
    }
  }
  return r as SessionCorrectionExport;
}

export function applyCorrectionsToCentralHistory(
  history: CentralHistoryFile,
  correction: SessionCorrectionExport,
  generatedAt: string,
): { history: CentralHistoryFile; report: ApplyCorrectionsReport } {
  if (history.officeId !== correction.officeId) {
    throw new Error(`Correctiebestand is voor kantoor ${correction.officeId}, historiek voor ${history.officeId}.`);
  }
  const report: ApplyCorrectionsReport = {
    sessionName: correction.sessionName,
    applied: [],
    alreadyApplied: [],
    notFound: [],
    mismatches: [],
  };
  const byNumber = new Map(correction.corrections.map((c) => [c.articleNumber, c]));
  const seen = new Set<string>();
  const entries = history.entries.map((entry) => {
    if (entry.sessionName !== correction.sessionName) return entry;
    const c = byNumber.get(entry.articleNumber);
    if (!c) return entry;
    seen.add(entry.articleNumber);
    if (entry.totalCount === c.newTotalCount) {
      report.alreadyApplied.push(entry.articleNumber);
      return entry;
    }
    if (c.oldTotalCount !== null && entry.totalCount !== c.oldTotalCount) {
      report.mismatches.push(
        `${entry.articleNumber}: centraal ${entry.totalCount}, correctiebestand verwachtte ${c.oldTotalCount}`,
      );
    }
    const carried = entry.status === "OVERGENOMEN" || entry.status === "OVERGENOMEN - NIET GETELD";
    const diffQty = carried || entry.differenceQuantity !== null ? Math.round((c.newTotalCount - (entry.previousCount ?? 0)) * 1e6) / 1e6 : null;
    const diffAmount =
      diffQty !== null && entry.costPrice !== null ? Math.round(diffQty * entry.costPrice * 1e6) / 1e6 : entry.differenceAmount;
    report.applied.push({ articleNumber: entry.articleNumber, oldTotalCount: entry.totalCount, newTotalCount: c.newTotalCount });
    return {
      ...entry,
      totalCount: c.newTotalCount,
      differenceQuantity: diffQty,
      differenceAmount: diffAmount,
      status: entry.status === "0 BEVESTIGD" && c.newTotalCount === 0 ? entry.status : ("GETELD" as const),
    };
  });
  for (const c of correction.corrections) if (!seen.has(c.articleNumber)) report.notFound.push(c.articleNumber);
  const next: CentralHistoryFile = { ...history, entries, generatedAt: report.applied.length > 0 ? generatedAt : history.generatedAt };
  return { history: next, report };
}

export { parseCentralHistoryFile, serializeCentralHistoryFile };
