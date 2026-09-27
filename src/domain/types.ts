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
  /**
   * Sprint 3.2.1 (architectuurfix — review na Sprint 3.2): of de eenmalige
   * Productgamma-migratiebootstrap (`domain/productCategory.ts#
   * migrateProductGroupsToCategories`) al voor DIT kantoor gedraaid heeft.
   *
   * Nodig sinds `ProductCategory` een GLOBALE entiteit werd (zie hieronder):
   * de oorspronkelijke idempotentie-check ("heeft dit kantoor al minstens één
   * categorie?") werkt niet meer zodra categorieën gedeeld worden — zodra
   * kantoor A gemigreerd heeft, zou kantoor B de (nu niet-lege) globale lijst
   * zien en zijn EIGEN migratie nooit meer draaien, waardoor B's artikelen
   * met een eigen, nog niet elders voorkomende bronproductgroep nooit
   * geclassificeerd zouden worden. Deze vlag maakt de bootstrap terug
   * per-kantoor idempotent, los van hoeveel andere kantoren al gemigreerd
   * hebben. BEWUST optioneel (`?`), net als `CountSession.locationIds?`:
   * een kantoor van vóór deze fix kent dit veld nog niet — ontbrekend/
   * `undefined` betekent gewoon "nog niet gemigreerd", en de bootstrap is
   * zelf volledig veilig om (opnieuw) te draaien (additief, matcht op naam).
   */
  categoriesMigrated?: boolean;
}

/**
 * Sprint 3.2 — Dynamic Product Categories: Argona's HUIDIGE, beheerde
 * management-classificatie ("Productgamma" in de UI, bv. Zonnepanelen,
 * Batterijen, Omvormers, Laadpalen, Kabels...). Dit is een STANDALONE,
 * persistente entiteit met een stabiele `id` — NIET dezelfde as als
 * `Article.productGroup` (de historische/bron-productgroep uit Excel, die
 * nooit met terugwerkende kracht wijzigt, zie `Article.productGroup` en
 * `domain/productCategory.ts` voor de volledige uitleg van dit onderscheid).
 * `id` wordt bewust NOOIT vervangen door de naam als referentie elders
 * (`Article.categoryId`, de PRODUCTGAMMAS-Excelsheet): een categorie kan
 * hernoemd worden zonder dat bestaande toewijzingen breken.
 *
 * Sprint 3.2.1 (architectuurfix): GLOBAAL voor heel Argona, NIET per kantoor
 * — "Kabels", "Laadpalen", "Batterijen" enz. zijn dezelfde categorie (zelfde
 * stabiele `id`) voor Antwerpen, Damme en Lokeren. Er bestaat dus GEEN
 * `officeId` meer op dit type (dat stond hier oorspronkelijk, bleek na
 * review de verkeerde businessregel: dat zou drie aparte "Kabels"-records
 * met verschillende ID's per kantoor opleveren). Welk kantoor een categorie
 * effectief GEBRUIKT volgt uitsluitend uit welke `Article.categoryId`'s naar
 * haar verwijzen — een expliciet "kantoorassortiment" (categorie X actief/
 * inactief PER kantoor) is bewust NIET in scope van deze sprint en volgt
 * pas in Sprint 3.2.1 als een apart concept.
 */
export interface ProductCategory {
  id: string;
  name: string;
  /** Weergavevolgorde (1-indexed, aanpasbaar via Instellingen) — zelfde patroon als `Location.number`. Globaal, dus dezelfde volgorde voor elk kantoor. */
  sortOrder: number;
  /**
   * Inactieve categorieën verdwijnen uit nieuwe toewijzingscontrols (net als
   * `Location.active`) maar blijven geldig/zichtbaar voor reeds toegewezen
   * artikelen en in historische analyses — nooit hard verwijderd zolang ze
   * gebruikt zijn (zie `domain/productCategory.ts`). Globaal: inactief maken
   * geldt voor alle kantoren tegelijk (er is nog geen per-kantoor
   * assortiment — zie hierboven).
   */
  active: boolean;
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

/**
 * Voorraadclassificatie (Sprint 2 — Historical Count Analysis): actief vs.
 * obsolete stock, voor voorraadwaarde-analyse. Dit is een APARTE as t.o.v.
 * `ArticleActiveStatus` hieronder (die gaat over telbaarheid/sessiescope,
 * zie `frequency.ts#normalizeArticleStatus` — een artikel met status
 * "OBSOLETE - PANEEL"/"OBSOLETE - ROOD" is daar gewoon INACTIVE, wat iets
 * anders is dan de classificatie hier). Een artikel kan dus ACTIEF/telbaar
 * én OBSOLETE (stockClassification) tegelijk zijn, of net andersom.
 * Enkel MINIMALE waarden deze sprint (spec): geen SLOW_MOVING — dat komt
 * pas later, berekend uit echte eBuddy-bewegingsdata (zie
 * `domain/stockClassification.ts`).
 */
export type StockClassification = "ACTIVE" | "OBSOLETE";

/**
 * CANCELLED (sessielogica-fix): een bewust geannuleerde sessie — nooit een
 * officiële telling. Blokkeert geen nieuwe sessie meer (enkel ACTIVE doet
 * dat, zie CountingRepository#getActiveSession) en telt nergens mee als
 * afgeronde stocktelling: geen rollend-archief-snapshot, geen HISTORIE-regels,
 * geen invloed op Article.previousCount, en verschijnt niet in de officiële
 * artikelgeschiedenis (zie domain/articleHistory.ts, die expliciet enkel
 * status === "COMPLETED" meetelt).
 */
export type CountSessionStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

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
  /**
   * Sprint 3.2 §2: "Bronproductgroep" — de historische/bron-productgroep
   * zoals aangetroffen in de brondata op het moment van import/snapshot (bv.
   * "LAADPALEN"). Dit veld verandert NOOIT met terugwerkende kracht en is
   * puur audit/naslag ("waar kwam dit artikel oorspronkelijk vandaan") — het
   * wordt NOOIT meer gebruikt voor management-groepering/-analyse. Zie
   * `categoryId` hieronder voor de huidige, beheerde classificatie.
   */
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
  /**
   * Voorraadclassificatie voor voorraadwaarde-analyse (Sprint 2). BEWUST
   * optioneel (`?`), net als `comment` hierboven: een gewone Excel-import
   * (of een bestaand `Article`-object van vóór deze sprint) kent dit veld
   * nog niet — ontbrekend/`undefined` betekent altijd "ACTIVE" (nooit een
   * harde default die alle bestaande `Article`-objectliteralen in de
   * codebase/tests zou moeten aanpassen). Zie
   * `domain/stockClassification.ts#getStockClassification` voor de enige
   * correcte manier om dit veld te lezen — nooit rechtstreeks
   * `article.stockClassification` vergelijken.
   */
  stockClassification?: StockClassification;
  /**
   * Sprint 3.2 §2/§7: de HUIDIGE, beheerde "Productgamma"-classificatie —
   * verwijst naar `ProductCategory.id` (nooit naar een naam, die kan
   * hernoemd worden). Mag retroactief wijzigen: management-analyses van OUDE
   * (reeds bevroren) sessies gebruiken bij het opbouwen altijd de HUIDIGE
   * waarde van dit veld, nooit een bevroren kopie (zie
   * `domain/productCategory.ts` en `AnalysisService`/`ComparisonService`).
   * BEWUST optioneel (`?`), exact het `stockClassification`-patroon
   * hierboven: een artikel van vóór deze sprint, of nog niet ingedeeld, kent
   * dit veld niet — ontbrekend/`undefined`/`null` betekenen alle drie
   * "nog niet ingedeeld" (nooit hard verwijderen, spec §9: "mag niet
   * verborgen worden").
   */
  categoryId?: string | null;
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
  /**
   * Locatie-IDs die bij het starten van deze sessie actief waren (data-
   * integriteit-sprint §5) — bevriest welke fysieke locaties voor DEZE sessie
   * "afgerond moeten worden", los van latere wijzigingen aan
   * `office.locations`. Een locatie die halverwege de sessie inactief wordt
   * gemaakt blijft verplicht voor deze sessie; een locatie die pas ná de
   * start wordt toegevoegd, wordt NIET plots verplicht.
   *
   * "Zonder locatie" (domain/withoutLocation.ts) is hier bewust niet aan
   * gekoppeld: dat blijft een dynamische worklijst puur op basis van
   * `articleIds`, nooit op `locationIds`.
   *
   * BEWUST optioneel (`?`), net als `cancelledAt`/`cancelReason` hieronder:
   * een sessie gestart vóór deze sprint kent dit veld niet. Ontbrekend
   * betekent "geen bevroren locatieset bekend" — zie
   * `domain/locations.ts#sessionLocations` voor de backward-compatible
   * fallback (dan wordt teruggevallen op de huidige actieve locaties, exact
   * het oude gedrag, dus geen dataverlies en geen crash op oude sessies).
   * Geen Dexie-schemawijziging nodig: niet-geïndexeerd veld.
   */
  locationIds?: string[];
  /**
   * Wanneer deze sessie geannuleerd werd (enkel gezet bij status CANCELLED).
   * BEWUST optioneel (`?`), net als `Article.comment` hierboven: een sessie
   * gemaakt vóór deze sessielogica-fix, of een gewone `startSession()`-
   * aanroep, kent dit veld gewoon nooit — ontbrekend/`undefined` betekent
   * altijd "nooit geannuleerd". Geen Dexie-schemawijziging nodig (zie
   * adapters/storage/db.ts): dit is een niet-geïndexeerd veld.
   */
  cancelledAt?: string | null;
  /**
   * Vrije, optionele reden bij annuleren (architecturaal voorbereid, spec:
   * "geen verplicht formulier bouwen") — vandaag door geen enkel scherm
   * ingevuld, maar al beschikbaar voor een latere UI-uitbreiding.
   */
  cancelReason?: string | null;
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
