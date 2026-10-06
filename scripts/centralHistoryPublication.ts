import { createHash } from "node:crypto";
import { createExcelStockSourceFromBuffer } from "../src/adapters/excel/ExcelStockSource";
import {
  buildCentralHistoryFile,
  type CentralHistoryFile,
} from "../src/domain/centralHistoryFile";
import { historyEntryKey, mergeHistoryEntries, type StockHistoryEntry } from "../src/domain/stockSnapshot";

export interface PublicationInput {
  /** Inhoud van een rollend Argona-Excelbestand (export uit de app). */
  buffer: ArrayBuffer;
  fileName: string;
  /** Het reeds gepubliceerde bestand van dit kantoor, indien aanwezig. */
  existing: CentralHistoryFile | null;
  /** `true` = bouw volledig opnieuw op uit enkel dit Excelbestand (negeer `existing`). */
  replace?: boolean;
  generatedAt: string;
}

export interface PublicationResult {
  file: CentralHistoryFile;
  stats: {
    officeId: string;
    totalEntries: number;
    addedEntries: number;
    sessionCount: number;
    legacyPeriodCount: number;
    derivedSessionIds: number;
  };
}

/** Stabiele, deterministische sessie-ID voor een sessie zonder `sourceSessionId` (bestand van vóór v0.9). */
export function deriveCentralSessionId(officeId: string, sessionName: string): string {
  return `central-${createHash("sha1").update(`${officeId}|${sessionName}`).digest("hex").slice(0, 16)}`;
}

/**
 * Bouwt (zonder iets weg te schrijven) het te publiceren centrale bestand uit
 * een Argona-Excelbestand. Pure functie → volledig testbaar; het CLI-script
 * (`publish-central-history.ts`) doet enkel het bestandsbeheer errond.
 *
 *  - Publiceren is ADDITIEF: standaard blijft alles uit het reeds
 *    gepubliceerde bestand behouden en vult het nieuwe export het aan (bij een
 *    botsing op (sessienaam, artikel) wint de nieuwe export — de publisher is
 *    de gezaghebbende bron). `replace` herbouwt volledig.
 *  - Regels van een echte sessie zonder `sourceSessionId` krijgen een
 *    deterministisch afgeleid ID, zodat elk toestel dezelfde sessie-identiteit
 *    krijgt (geen dubbels, en de sessie is beschermd tegen lokaal verwijderen).
 */
export async function buildPublication(input: PublicationInput): Promise<PublicationResult> {
  const source = createExcelStockSourceFromBuffer(input.buffer, input.fileName);
  const office = await source.loadOffice();
  const incoming = (await source.loadHistory?.()) ?? [];
  if (incoming.length === 0) {
    throw new Error(
      `"${input.fileName}" bevat geen telhistoriek (sheet HISTORIE is leeg of ontbreekt) — er valt niets te publiceren.`,
    );
  }

  let derivedSessionIds = 0;
  const withIds: StockHistoryEntry[] = incoming.map((entry) => {
    if (entry.source === "LEGACY_IMPORT" || entry.sourceSessionId) return entry;
    derivedSessionIds += 1;
    return { ...entry, sourceSessionId: deriveCentralSessionId(office.id, entry.sessionName) };
  });

  const previous = input.replace ? [] : (input.existing?.entries ?? []);
  if (input.existing && input.existing.officeId !== office.id) {
    throw new Error(
      `Het bestaande centrale bestand hoort bij "${input.existing.officeId}", dit Excelbestand bij "${office.id}".`,
    );
  }
  const previousKeys = new Set(previous.map(historyEntryKey));
  const previousIdByKey = new Map(previous.map((e) => [historyEntryKey(e), e.sourceSessionId]));

  // Een eenmaal gepubliceerd sessie-ID blijft behouden (geen "flapperende" ID's
  // wanneer een latere export dezelfde sessie met een ander ID zou dragen).
  const merged = mergeHistoryEntries(previous, withIds).map((entry) => {
    const keptId = previousIdByKey.get(historyEntryKey(entry));
    return keptId && entry.source !== "LEGACY_IMPORT" ? { ...entry, sourceSessionId: keptId } : entry;
  });

  const file = buildCentralHistoryFile({
    officeId: office.id,
    generatedAt: input.generatedAt,
    entries: merged,
    deletedSessionIds: input.replace ? [] : (input.existing?.deletedSessionIds ?? []),
  });

  const sessionNames = new Set(merged.filter((e) => e.source !== "LEGACY_IMPORT").map((e) => e.sessionName));
  const legacyNames = new Set(merged.filter((e) => e.source === "LEGACY_IMPORT").map((e) => e.sessionName));
  return {
    file,
    stats: {
      officeId: office.id,
      totalEntries: merged.length,
      addedEntries: merged.filter((e) => !previousKeys.has(historyEntryKey(e))).length,
      sessionCount: sessionNames.size,
      legacyPeriodCount: legacyNames.size,
      derivedSessionIds,
    },
  };
}
