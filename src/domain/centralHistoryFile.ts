import { sessionSnapshotName } from "./stockSnapshot";
import type { ArticleSnapshotStatus, StockHistoryEntry } from "./stockSnapshot";
import type { Article, CountSession, CountSessionType } from "./types";

/**
 * Centrale, read-only historiek ("Central read-only historical data").
 *
 * Eén bestand per kantoor met alle afgeronde historische telregels (incl.
 * legacy-periodes) — gepubliceerd via script/git/Vercel, NOOIT vanuit de
 * gewone app (zie docs/CENTRAL_HISTORY.md). De app leest dit bestand enkel
 * (via een `CentralHistorySource`) en voegt het ADDITIEF samen met de lokale
 * data: zie `CentralHistorySyncService`.
 *
 * Schema v1:
 *
 *   {
 *     "schemaVersion": 1,
 *     "officeId": "damme",
 *     "generatedAt": "2026-10-01T12:00:00.000Z",
 *     "deletedSessionIds": [],            // tombstones — v1: geparsed, NOG NIET toegepast
 *     "entries": [ StockHistoryEntry, ... ]
 *   }
 *
 * Ontwerpregel (user-eis 3, v1): "afwezig in het bestand" betekent NOOIT
 * "verwijderen". Verwijderen kan later enkel via een EXPLICIETE tombstone in
 * `deletedSessionIds` — daarom staat het veld nu al in het schema, zodat een
 * latere versie dit kan toepassen zonder `schemaVersion` te moeten verhogen.
 */
export const CENTRAL_HISTORY_SCHEMA_VERSION = 1;

export interface CentralHistoryFile {
  schemaVersion: typeof CENTRAL_HISTORY_SCHEMA_VERSION;
  officeId: string;
  generatedAt: string;
  /** Expliciete tombstones (sessie-ID's). v1: wordt geparsed maar door de sync NIET toegepast. */
  deletedSessionIds: string[];
  entries: StockHistoryEntry[];
}

/**
 * Per-kantoor status van de laatste centrale sync (user-eis 6) — bewaard in
 * IndexedDB (`centralHistoryStatus`, Dexie v8), enkel voor weergave in
 * Instellingen en voor de verwijder-bescherming van centrale sessies.
 */
export interface CentralHistoryStatus {
  officeId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Discrete waarschuwing/foutmelding van de laatste poging; `null` = alles in orde. */
  lastError: string | null;
  /** `generatedAt` van het laatst succesvol verwerkte centrale bestand. */
  lastGeneratedAt: string | null;
  /** Aantal sessies dat de laatste succesvolle sync lokaal NIEUW aanmaakte. */
  lastAddedSessionCount: number;
  /**
   * Alle lokale `CountSession.id`'s die (ook) centraal bestaan — deze zijn in
   * v1 read-only qua verwijdering in de gewone app (user-eis: correctie/
   * verwijdering gebeurt aan de centrale bron). Groeit enkel (additief).
   */
  centralSessionIds: string[];
  /**
   * Snapshotnamen (`sessionSnapshotName`) van alle centrale sessies — vangt een
   * lokale sessie die enkel op NAAM (niet op id) overeenkomt met een centrale
   * sessie, zodat ook die niet verwijderd kan worden om daarna terug te keren.
   */
  centralSessionNames: string[];
}

export class CentralHistoryFormatError extends Error {
  constructor(message: string) {
    super(`Ongeldig centraal historiekbestand: ${message}`);
    this.name = "CentralHistoryFormatError";
  }
}

const SESSION_TYPES: readonly CountSessionType[] = ["MONTHLY", "QUARTERLY", "YEARLY", "FULL"];
const STATUSES: readonly ArticleSnapshotStatus[] = [
  "GETELD",
  "0 BEVESTIGD",
  "OVERGENOMEN",
  "OVERGENOMEN - NIET GETELD",
  "LEGACY",
];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new CentralHistoryFormatError(`${where}: "${key}" moet tekst zijn.`);
  return value;
}

function requireNumberOrNull(record: Record<string, unknown>, key: string, where: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CentralHistoryFormatError(`${where}: "${key}" moet een getal of null zijn.`);
  }
  return value;
}

function parseEntry(raw: unknown, index: number): StockHistoryEntry {
  const where = `entries[${index}]`;
  if (!isRecord(raw)) throw new CentralHistoryFormatError(`${where} is geen object.`);

  const countDate = requireString(raw, "countDate", where);
  if (!DATE_PATTERN.test(countDate)) {
    throw new CentralHistoryFormatError(`${where}: "countDate" moet het formaat YYYY-MM-DD hebben.`);
  }
  const sessionType = requireString(raw, "sessionType", where) as CountSessionType;
  if (!SESSION_TYPES.includes(sessionType)) {
    throw new CentralHistoryFormatError(`${where}: onbekend "sessionType" (${sessionType}).`);
  }
  const status = requireString(raw, "status", where) as ArticleSnapshotStatus;
  if (!STATUSES.includes(status)) {
    throw new CentralHistoryFormatError(`${where}: onbekende "status" (${status}).`);
  }
  const sessionName = requireString(raw, "sessionName", where);
  const articleId = requireString(raw, "articleId", where);
  if (sessionName === "" || articleId === "") {
    throw new CentralHistoryFormatError(`${where}: "sessionName" en "articleId" mogen niet leeg zijn.`);
  }
  const locationNamesRaw = raw.locationNames ?? [];
  if (!Array.isArray(locationNamesRaw) || locationNamesRaw.some((l) => typeof l !== "string")) {
    throw new CentralHistoryFormatError(`${where}: "locationNames" moet een lijst met tekst zijn.`);
  }

  const entry: StockHistoryEntry = {
    countDate,
    sessionType,
    sessionName,
    articleId,
    articleNumber: requireString(raw, "articleNumber", where),
    description: requireString(raw, "description", where),
    totalCount: requireNumberOrNull(raw, "totalCount", where),
    previousCount: requireNumberOrNull(raw, "previousCount", where),
    differenceQuantity: requireNumberOrNull(raw, "differenceQuantity", where),
    costPrice: requireNumberOrNull(raw, "costPrice", where),
    differenceAmount: requireNumberOrNull(raw, "differenceAmount", where),
    status,
    locationNames: locationNamesRaw as string[],
  };

  if (raw.source !== undefined) {
    if (raw.source !== "APP" && raw.source !== "LEGACY_IMPORT") {
      throw new CentralHistoryFormatError(`${where}: onbekende "source" (${String(raw.source)}).`);
    }
    entry.source = raw.source;
  }
  if (raw.sourceSessionId !== undefined) {
    if (typeof raw.sourceSessionId !== "string" || raw.sourceSessionId === "") {
      throw new CentralHistoryFormatError(`${where}: "sourceSessionId" moet niet-lege tekst zijn.`);
    }
    entry.sourceSessionId = raw.sourceSessionId;
  }
  if (raw.sourceProductGroup !== undefined) {
    if (raw.sourceProductGroup !== null && typeof raw.sourceProductGroup !== "string") {
      throw new CentralHistoryFormatError(`${where}: "sourceProductGroup" moet tekst of null zijn.`);
    }
    entry.sourceProductGroup = raw.sourceProductGroup;
  }
  return entry;
}

/**
 * Valideert (strikt, alles-of-niets) en normaliseert een ruw JSON-resultaat
 * tot een `CentralHistoryFile`. Onbekende extra velden (op het niveau van het
 * bestand of van een regel) worden genegeerd — forward-compat voor additieve
 * wijzigingen binnen dezelfde `schemaVersion`; een HOGERE `schemaVersion`
 * wordt daarentegen expliciet geweigerd (de app moet dan eerst bijwerken).
 *
 * `expectedOfficeId`: een bestand voor een ander kantoor wordt geweigerd —
 * nooit data van kantoor A in kantoor B laten belanden.
 */
export function parseCentralHistoryFile(raw: unknown, expectedOfficeId?: string): CentralHistoryFile {
  if (!isRecord(raw)) throw new CentralHistoryFormatError("het bestand is geen JSON-object.");

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== CENTRAL_HISTORY_SCHEMA_VERSION) {
    throw new CentralHistoryFormatError(
      typeof schemaVersion === "number" && schemaVersion > CENTRAL_HISTORY_SCHEMA_VERSION
        ? `schemaVersion ${schemaVersion} is nieuwer dan deze app begrijpt (${CENTRAL_HISTORY_SCHEMA_VERSION}) — de app moet eerst bijgewerkt worden.`
        : `onbekende schemaVersion (${String(schemaVersion)}).`,
    );
  }

  const officeId = raw.officeId;
  if (typeof officeId !== "string" || officeId === "") {
    throw new CentralHistoryFormatError('"officeId" ontbreekt.');
  }
  if (expectedOfficeId !== undefined && officeId !== expectedOfficeId) {
    throw new CentralHistoryFormatError(
      `het bestand hoort bij kantoor "${officeId}", niet bij "${expectedOfficeId}".`,
    );
  }

  const generatedAt = raw.generatedAt;
  if (typeof generatedAt !== "string" || Number.isNaN(new Date(generatedAt).getTime())) {
    throw new CentralHistoryFormatError('"generatedAt" ontbreekt of is geen geldige datum.');
  }

  if (!Array.isArray(raw.entries)) throw new CentralHistoryFormatError('"entries" moet een lijst zijn.');
  const entries = raw.entries.map((entry, index) => parseEntry(entry, index));

  const deletedRaw = raw.deletedSessionIds ?? [];
  if (!Array.isArray(deletedRaw) || deletedRaw.some((id) => typeof id !== "string" || id === "")) {
    throw new CentralHistoryFormatError('"deletedSessionIds" moet een lijst met niet-lege tekst zijn.');
  }

  return {
    schemaVersion: CENTRAL_HISTORY_SCHEMA_VERSION,
    officeId,
    generatedAt,
    deletedSessionIds: deletedRaw as string[],
    entries,
  };
}

/**
 * Bouwt een publiceerbaar bestand (voor het publish-script): deterministisch
 * gesorteerd (datum, sessienaam, artikelnummer) zodat git-diffs klein blijven
 * en twee publicaties van dezelfde data byte-voor-byte identiek zijn.
 */
export function buildCentralHistoryFile(input: {
  officeId: string;
  generatedAt: string;
  entries: StockHistoryEntry[];
  deletedSessionIds?: string[];
}): CentralHistoryFile {
  const entries = [...input.entries].sort((a, b) => {
    const byDate = a.countDate.localeCompare(b.countDate);
    if (byDate !== 0) return byDate;
    const bySession = a.sessionName.localeCompare(b.sessionName, "nl");
    if (bySession !== 0) return bySession;
    return a.articleId.localeCompare(b.articleId, "nl");
  });
  return {
    schemaVersion: CENTRAL_HISTORY_SCHEMA_VERSION,
    officeId: input.officeId,
    generatedAt: input.generatedAt,
    deletedSessionIds: [...(input.deletedSessionIds ?? [])].sort(),
    entries,
  };
}

/**
 * Serialiseert naar de vaste bestandsvorm: kopvelden leesbaar, daarna ÉÉN
 * regel per `entries`-element — houdt git-diffs bij een nieuwe publicatie
 * klein en leesbaar, en is deterministisch (zelfde input = zelfde bytes).
 */
export function serializeCentralHistoryFile(file: CentralHistoryFile): string {
  const entryLines = file.entries.map((entry) => `    ${JSON.stringify(entry)}`);
  return (
    "{\n" +
    `  "schemaVersion": ${file.schemaVersion},\n` +
    `  "officeId": ${JSON.stringify(file.officeId)},\n` +
    `  "generatedAt": ${JSON.stringify(file.generatedAt)},\n` +
    `  "deletedSessionIds": ${JSON.stringify(file.deletedSessionIds)},\n` +
    '  "entries": [' +
    (entryLines.length > 0 ? `\n${entryLines.join(",\n")}\n  ` : "") +
    "]\n}\n"
  );
}

/** De stabiele sessie-ID's (`sourceSessionId`) van alle ECHTE app-sessies in deze regels (legacy-regels hebben er nooit één). */
export function centralSessionIdsOf(entries: readonly StockHistoryEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.source === "LEGACY_IMPORT") continue;
    if (entry.sourceSessionId) ids.add(entry.sourceSessionId);
  }
  return Array.from(ids);
}

/**
 * Een centrale regel kan naar een artikel verwijzen dat dit toestel (nog)
 * niet kent — bv. een artikel dat intussen uit het masterbestand verdween.
 * Snapshots/Analyse hebben altijd een `Article`-record nodig; dit bouwt, naar
 * het voorbeeld van `legacyImport.ts#buildLegacyOnlyArticle`, een historisch/
 * INACTIEF record (`assortmentActive: false`, `status: "INACTIVE"`) — nooit
 * in een nieuwe telling, nooit een bestaand levend artikel overschrijven (de
 * aanroeper maakt dit enkel voor ONBEKENDE artikel-ID's).
 */
export function buildHistoricalOnlyArticle(entry: StockHistoryEntry, officeId: string): Article {
  return {
    id: entry.articleId,
    officeId,
    articleNumber: entry.articleNumber,
    officialArticleNumber: null,
    idType: entry.source === "LEGACY_IMPORT" ? "LEGACY" : "CENTRALE HISTORIEK",
    description: entry.description,
    productGroup: entry.sourceProductGroup ?? null,
    supplier: null,
    unit: null,
    costPrice: entry.costPrice,
    rawCountPeriod: null,
    countPeriod: "NOT_APPLICABLE",
    // Zelfde reden als buildLegacyOnlyArticle: een ERKENDE niet-actief-markering,
    // zodat een export/herimport-cyclus dit artikel niet stilzwijgend ACTIVE maakt.
    rawStatus: "NON-ACTIEF",
    status: "INACTIVE",
    previousCount: null,
    sourceRow: null,
    assortmentActive: false,
  };
}

/** Pure variant van `CentralHistorySyncService#isCentralSession` (ook bruikbaar vanuit een UI-hook met een reeds geladen status). */
export function isCentralSessionIn(
  status: CentralHistoryStatus | undefined,
  session: Pick<CountSession, "id" | "type" | "completedAt" | "startedAt">,
): boolean {
  if (!status) return false;
  if (status.centralSessionIds.includes(session.id)) return true;
  return status.centralSessionNames.includes(sessionSnapshotName(session));
}
