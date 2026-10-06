import Dexie, { type Table } from "dexie";
import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  LocationSessionStatus,
  Office,
  ProductCategory,
} from "../../domain/types";
import type {
  FinalizedSessionResult,
  HistoricalSheetRecord,
  ImportMeta,
} from "../../application/ports/CountingRepository";
import type { CentralHistoryStatus } from "../../domain/centralHistoryFile";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";

/** Eén rij "app-brede" UI-voorkeur (welk kantoor laatst actief was). Geen businessdata. */
export interface AppStateRow {
  id: "singleton";
  selectedOfficeId: string;
}

/**
 * Eén rij toestel-lokale configuratie van de centrale historiek (v8): de
 * toegangscode voor het beveiligde centrale endpoint. Staat bewust NIET in
 * `AppStateRow`: `setSelectedOfficeId` vervangt die hele rij (`put`) en zou de
 * code stilletjes wissen. Geen businessdata, nooit geëxporteerd naar Excel.
 */
export interface CentralHistoryConfigRow {
  id: "singleton";
  accessCode: string | null;
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
  productCategories!: Table<ProductCategory, string>;
  centralHistoryStatus!: Table<CentralHistoryStatus, string>;
  centralHistoryConfig!: Table<CentralHistoryConfigRow, string>;

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
    // v6 (Sprint 3.2 — Dynamic Product Categories): de standalone,
    // persistente "Productgamma"-entiteit (zie domain/types.ts#ProductCategory
    // en domain/productCategory.ts) — puur additief, een volledig NIEUWE
    // tabel, dus een bestaande database (versies 1-5) upgradet hier zonder
    // dataverlies of crash. `Article.categoryId` zelf is een niet-geïndexeerd
    // veld op de al bestaande `articles`-tabel (zie `Article` in
    // domain/types.ts) en heeft daarom geen aparte schemawijziging nodig —
    // exact hetzelfde patroon als `Article.stockClassification` in Sprint 2.
    this.version(6).stores({
      productCategories: "id, officeId",
    });
    // v7 (Sprint 3.2.1-architectuurfix): `ProductCategory` blijkt bedrijfsbreed/
    // globaal te moeten zijn, niet office-scoped (zie domain/types.ts#
    // ProductCategory) — "Kabels" moet dezelfde stabiele ID hebben voor
    // Antwerpen, Damme en Lokeren. De `officeId`-index op deze tabel vervalt
    // daarom hier; Dexie-versioning-discipline: een NIEUWE versie die het
    // schema herdefinieert, nooit een bestaande versie in-place wijzigen. Dit
    // is een pure index-wijziging (het veld zelf verdwijnt uit de records via
    // normale toepassingslogica, niet via een schema-migratiefunctie hier) —
    // bestaande lokale databases (versies 1-6) upgraden zonder crash; enkel
    // het (nu overbodige) `officeId`-veld op reeds opgeslagen categorierijen
    // blijft fysiek in IndexedDB staan tot de eerstvolgende
    // `saveProductCategories`-aanroep die rij overschrijft (onschadelijk: het
    // domein/de UI lezen dat veld nergens meer).
    this.version(7).stores({
      productCategories: "id",
    });
    // v8 (centrale read-only historiek): per kantoor de status van de laatste
    // centrale sync (incl. welke lokale sessies centraal zijn — read-only qua
    // verwijdering) en één rij toestel-lokale configuratie (toegangscode).
    // Puur additief — twee volledig NIEUWE tabellen, geen bestaande tabel/index
    // gewijzigd, dus een bestaande database (versies 1-7) upgradet zonder
    // dataverlies of crash.
    this.version(8).stores({
      centralHistoryStatus: "officeId",
      centralHistoryConfig: "id",
    });
  }
}

/** Standaard, gedeelde databaseinstantie voor de hele app. */
export const db = new AppDatabase();
