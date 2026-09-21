/**
 * Domain model for Argona Stocktelling.
 *
 * Deze module bevat ENKEL domeinbegrippen. Er mag hier niets staan dat iets
 * weet over Excel, IndexedDB, React of eBuddy. Zie docs/ARCHITECTURE.md.
 */

/**
 * Eén stocklocatie van een kantoor (v0.2.1: dynamische lijst, geen vaste 5
 * meer — zie domain/locations.ts en spec v0.2.1 §1). `number` is de huidige
 * weergavevolgorde (1-indexed, aanpasbaar via Instellingen), geen vaste
 * identiteit — `id` is dat wel, en is wat CountEntry/ArticleLocationAssignment
 * gebruiken, zodat een hernummering historische data nooit kan breken.
 */
export interface Location {
  id: string;
  officeId: string;
  /** Huidige volgorde (1-indexed, aanpasbaar). Puur weergave/exportvolgorde. */
  number: number;
  /** Door de gebruiker aanpasbare naam. Nooit leeg: valt terug op "Locatie N". */
  name: string;
  /**
   * Inactieve locaties zijn "zacht verwijderd": ze verdwijnen uit nieuwe
   * telacties (locatie-overzicht, "+Ander artikel" locatiekeuze, enz.) maar
   * blijven bestaan zodat historische CountEntries/assignments die naar hun
   * `id` verwijzen geldig blijven. Enkel een nooit-gebruikte locatie mag hard
   * verwijderd worden (domain/locations.ts#canHardDeleteLocation).
   */
  active: boolean;
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
  /**
   * Vrije opmerking bij het artikel (v0.2.1 correctieronde §3: optioneel veld
   * bij "+ Nieuw artikel" / "+ Nieuw artikel gevonden"). BEWUST optioneel
   * (`?`) i.p.v. `string | null` als vast veld: een gewone Excel-import kent
   * dit begrip niet en mag dit veld gewoon nooit zetten, zonder dat alle
   * bestaande code/tests die een `Article` opbouwen dit moeten meegeven.
   * Ontbrekend/`undefined` en `null` betekenen hetzelfde: geen opmerking.
   */
  comment?: string | null;
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
 * Hoe deze CountEntry tot stand kwam (v0.2.1 §5).
 *   COUNTED           -> effectief op een fysieke locatie geteld.
 *   CONFIRMED_ABSENT  -> expliciet bevestigd dat het artikel nergens werd
 *                        aangetroffen (voorraad 0). Geen fysieke locatie
 *                        (zie CountEntry.locationId) — dit is een uitspraak
 *                        over het hele kantoor, niet over één rek.
 */
export type ArticleCountResolution = "COUNTED" | "CONFIRMED_ABSENT";

/**
 * Eén telling van één artikel, binnen één sessie.
 *
 * BELANGRIJK (zie ook docs/DATA_MODEL.md):
 *   quantity = 0    & counted = true   -> geldig geteld resultaat van nul stuks
 *   quantity = null & counted = false  -> nog niet geteld
 * Gebruik NOOIT enkel `quantity` om te bepalen of iets geteld is: gebruik altijd `counted`.
 *
 * `locationId` is enkel `null` voor `resolution: "CONFIRMED_ABSENT"` — een
 * bevestigd-afwezig artikel is niet "op" een locatie geteld, en er wordt
 * bewust geen fictieve locatie voor verzonnen (spec v0.2.1 §5).
 */
export interface CountEntry {
  id: string;
  sessionId: string;
  articleId: string;
  locationId: string | null;
  quantity: number | null;
  counted: boolean;
  countedAt: string | null;
  note: string | null;
  resolution: ArticleCountResolution;
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

/**
 * Status van één locatie BINNEN één sessie (v0.2.1 §4) — losstaand van
 * `Location.active`. Een artikel geteld op Rek 1 is niet automatisch "af",
 * want het kan ook nog op Rek 4 liggen; pas wanneer een locatie zelf als
 * afgerond gemarkeerd wordt (expliciete "✓ Locatie afgerond"-actie) telt ze
 * mee om te weten of "nergens aangetroffen" (§5) al betrouwbaar is. Een
 * afgeronde locatie kan altijd opnieuw geopend worden.
 */
export type LocationSessionState = "OPEN" | "COMPLETED";

export interface LocationSessionStatus {
  id: string;
  sessionId: string;
  locationId: string;
  status: LocationSessionState;
  completedAt: string | null;
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
