import Dexie, { type Table } from "dexie";
import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  LocationSessionStatus,
  Office,
} from "../../domain/types";
import type {
  FinalizedSessionResult,
  HistoricalSheetRecord,
  ImportMeta,
} from "../../application/ports/CountingRepository";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";

/** Eén rij "app-brede" UI-voorkeur (welk kantoor laatst actief was). Geen businessdata. */
export interface AppStateRow {
  id: "singleton";
  selectedOfficeId: string;
}

/** Opslagrij voor `HistoricalSheetRecord` — `id` = `${officeId}:${sheetName}` (uniek, dus een upsert). */
export interface HistoricalSheetRow extends HistoricalSheetRecord {
  id: string;
}

/** Opslagrij voor `StockHistoryEntry` — `id` = `${officeId}:${sessionName}:${articleId}` (uniek per (kantoor, telling, artikel)). */
export interface StockHistoryEntryRow extends StockHistoryEntry {
  id: string;
  officeId: string;
}

/**
 * IndexedDB-schema (via Dexie). Dit is puur opslag: geen businesslogica.
 * Alle velden komen 1-op-1 overeen met de domeintypes in src/domain/types.ts.
 */
export class AppDatabase extends Dexie {
  offices!: Table<Office, string>;
  articles!: Table<Article, string>;
  sessions!: Table<CountSession, string>;
  countEntries!: Table<CountEntry, string>;
  assignments!: Table<ArticleLocationAssignment, string>;
  importMeta!: Table<ImportMeta, string>;
  appState!: Table<AppStateRow, string>;
  locationSessionStatuses!: Table<LocationSessionStatus, string>;
  historicalSheets!: Table<HistoricalSheetRow, string>;
  stockHistoryEntries!: Table<StockHistoryEntryRow, string>;
  finalizedSessionResults!: Table<FinalizedSessionResult, string>;

  constructor(name = "argona-stocktelling") {
    super(name);
    this.version(1).stores({
      offices: "id",
      articles: "id, officeId",
      sessions: "id, officeId, status",
      countEntries: "id, sessionId, articleId, locationId",
      assignments: "id, officeId, articleId, locationId, [officeId+locationId]",
      importMeta: "officeId",
    });
    // v2: ondersteuning voor meerdere kantoren in dezelfde installatie — welk
    // kantoor laatst geselecteerd was, moet een refresh overleven.
    this.version(2).stores({
      appState: "id",
    });
    // v3 (v0.2.1): status per (sessie, locatie) — "✓ Locatie afgerond" en de
    // "nergens aangetroffen"-betrouwbaarheidsgate. Puur additief, zoals
    // gedocumenteerd in docs/ARCHITECTURE.md: geen bestaande tabel gewijzigd.
    this.version(3).stores({
      locationSessionStatuses: "id, sessionId, locationId, [sessionId+locationId]",
    });
    // v4 (rollend stockarchief): bevroren historische tellingtabs (ruwe
    // passthrough-rijen, geïmporteerd en/of zelf gegenereerd) en de
    // machinevriendelijke HISTORIE-log. Puur additief — geen bestaande
    // tabel/index gewijzigd, dus oudere lokale databases blijven werken.
    this.version(4).stores({
      historicalSheets: "id, officeId, sessionId",
      stockHistoryEntries: "id, officeId, articleId, sessionName",
    });
    // v5 (data-integriteit-sprint §3): het bevroren `FinalizedSessionResult`
    // (review + snapshot) per afgeronde sessie — puur additief, een volledig
    // NIEUWE tabel, dus een bestaande v0.2.1/v0.3-database (versies 1-4)
    // upgradet hier zonder dataverlies of crash. Sessies die vóór deze
    // upgrade al COMPLETED waren, krijgen gewoonweg nooit een rij in deze
    // tabel (`getFinalizedSessionResult` geeft dan `undefined` terug) — zie
    // `ExportService`s backward-compatibele terugvalpad.
    this.version(5).stores({
      finalizedSessionResults: "sessionId",
    });
  }
}

/** Standaard, gedeelde databaseinstantie voor de hele app. */
export const db = new AppDatabase();
