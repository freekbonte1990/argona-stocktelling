import Dexie, { type Table } from "dexie";
import type {
  Article,
  ArticleLocationAssignment,
  CountEntry,
  CountSession,
  Office,
} from "../../domain/types";
import type { ImportMeta } from "../../application/ports/CountingRepository";

/** Eén rij "app-brede" UI-voorkeur (welk kantoor laatst actief was). Geen businessdata. */
export interface AppStateRow {
  id: "singleton";
  selectedOfficeId: string;
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
  }
}

/** Standaard, gedeelde databaseinstantie voor de hele app. */
export const db = new AppDatabase();
