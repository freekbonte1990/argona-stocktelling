/**
 * Domain model for Argona Stocktelling.
 *
 * Deze module bevat ENKEL domeinbegrippen. Er mag hier niets staan dat iets
 * weet over Excel, IndexedDB, React of eBuddy. Zie docs/ARCHITECTURE.md.
 */

/** De vijf telzones van een kantoor. Nummer is altijd 1..5. */
export interface Location {
  id: string;
  officeId: string;
  number: 1 | 2 | 3 | 4 | 5;
  /** Door de gebruiker aanpasbare naam. Nooit leeg: valt terug op "Locatie N". */
  name: string;
}

export interface Office {
  id: string;
  name: string;
  /** Basisdatum van de laatste/huidige telperiode zoals in CONFIG-sheet. */
  baseDate: string | null;
  locations: Location[];
}

/**
 * Genormaliseerde telfrequentie van een artikel (kolom TELPERIODE).
 * Zie frequency.ts voor de normalisatielogica.
 */
export type ArticleCountFrequency =
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY"
  | "NOT_APPLICABLE"
  | "TO_BE_DETERMINED";

/** Type nieuwe telling die gestart kan worden. */
export type CountSessionType = "MONTHLY" | "QUARTERLY" | "YEARLY" | "FULL";

export type CountSessionStatus = "ACTIVE" | "COMPLETED";

/**
 * Al dan niet actief/geblokkeerd artikelstatus, genormaliseerd uit de vrije
 * tekst in de kolom "Artikelstatus". Zie frequency.ts: normalizeArticleStatus.
 */
export type ArticleActiveStatus = "ACTIVE" | "INACTIVE";

export interface Article {
  /** Intern uniek ID (afgeleid van officeId + artikelnr.). */
  id: string;
  officeId: string;
  /** Kolom "Artikelnr." — mag een officieel nummer of tijdelijk nummer zijn (bv. TMP-DAM-0001). */
  articleNumber: string;
  /** Kolom "Officieel artikelnr." — leeg zolang een tijdelijk artikel niet is omgezet. */
  officialArticleNumber: string | null;
  /** Kolom "ID type" — vrije tekst uit ARTIKEL-sheet (bv. "TIJDELIJK", "OFFICIEEL"). */
  idType: string | null;
  description: string;
  productGroup: string | null;
  supplier: string | null;
  unit: string | null;
  costPrice: number | null;
  /** Ruwe waarde uit Excel, ongewijzigd bewaard voor traceerbaarheid/debug. */
  rawCountPeriod: string | null;
  countPeriod: ArticleCountFrequency;
  rawStatus: string | null;
  status: ArticleActiveStatus;
  previousCount: number | null;
  /** Rijnummer in het bronbestand (kolom "Bronrij"), voor foutmeldingen/debug. */
  sourceRow: number | null;
}

export interface CountSession {
  id: string;
  officeId: string;
  type: CountSessionType;
  status: CountSessionStatus;
  startedAt: string;
  completedAt: string | null;
  sourceFileName: string;
  sourceBaseDate: string | null;
  /** Artikel-IDs die bij het starten van deze sessie in scope zijn genomen. */
  articleIds: string[];
}

/**
 * Eén telling van één artikel op één locatie, binnen één sessie.
 *
 * BELANGRIJK (zie ook docs/DATA_MODEL.md):
 *   quantity = 0    & counted = true   -> geldig geteld resultaat van nul stuks
 *   quantity = null & counted = false  -> nog niet geteld
 * Gebruik NOOIT enkel `quantity` om te bepalen of iets geteld is: gebruik altijd `counted`.
 */
export interface CountEntry {
  id: string;
  sessionId: string;
  articleId: string;
  locationId: string;
  quantity: number | null;
  counted: boolean;
  countedAt: string | null;
  note: string | null;
}

/**
 * Geleerde koppeling: dit artikel wordt normaal op deze locatie verwacht.
 * Eén artikel kan aan meerdere locaties gekoppeld zijn (active tegelijk).
 */
export interface ArticleLocationAssignment {
  id: string;
  officeId: string;
  articleId: string;
  locationId: string;
  active: boolean;
  lastSeenAt: string;
}

/** Voortgang van één locatie binnen een sessie (location-entry niveau). */
export interface LocationProgress {
  locationId: string;
  countedEntries: number;
  totalEntries: number;
}

/** Voortgang van een volledige sessie, met correcte (niet-naïeve) telling. */
export interface SessionProgress {
  /** Som van alle location-entries (kan artikelen dubbel tellen over locaties heen). */
  totalLocationEntries: number;
  countedLocationEntries: number;
  /** Aantal unieke artikelen in scope, resp. volledig afgewerkt op al hun verwachte locaties. */
  totalUniqueArticles: number;
  completedUniqueArticles: number;
  perLocation: LocationProgress[];
}
