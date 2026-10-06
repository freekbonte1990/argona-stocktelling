# Architectuur — Argona Stocktelling (v0.1 + v0.1.1 hardening + v0.2)

## Doel van dit document

Kort overzicht van hoe de app is opgebouwd, en vooral: **waarom** ze zo is
opgebouwd. Het belangrijkste architecturale uitgangspunt komt rechtstreeks
uit de opdracht:

> Excel is voorlopig slechts een import/export-adapter. Later moeten we de
> Excel-adapter kunnen vervangen door een eBuddy/API-adapter zonder de
> telinterface opnieuw te bouwen.

Alles hieronder is daarop ingericht.

## Lagen

```
src/
  domain/            <- pure business-regels, geen enkele afhankelijkheid
  application/
    ports/            <- interfaces (StockSource, CountingRepository, StockResultExporter)
    services/         <- orkestratie, gebruikt enkel ports + domain
  adapters/
    excel/            <- StockSource-implementatie bovenop een Excelbestand
    storage/           <- CountingRepository-implementatie bovenop IndexedDB (Dexie)
  ui/
    components/       <- kleine, domme presentatiecomponenten
    pages/            <- schermen, gebruiken enkel application/services + ui/hooks
    hooks/            <- React-hooks, o.a. reactieve IndexedDB-reads
```

Afhankelijkheidsrichting is altijd naar binnen: `ui` → `application` →
`domain`. `adapters` implementeren de `ports` uit `application` en worden
door niemand anders dan `application/container.ts` en de UI-instapschermen
rechtstreeks gebruikt.

### domain/

Bevat de kernbegrippen (Office, Location, Article, CountSession, CountEntry,
ArticleLocationAssignment — zie `docs/DATA_MODEL.md`) en pure functies:
telfrequentie normaliseren/selecteren (`frequency.ts`), voortgang berekenen
(`progress.ts`), sortering (`sorting.ts`). Niets hier weet dat Excel of
IndexedDB bestaan. Dit is ook de laag met de meeste unit tests, omdat het de
regels bevat die het meest kans hebben om subtiel fout te gaan (bv. de
0-versus-null tellingsemantiek).

### application/ports/

Twee interfaces, bewust klein gehouden:

- `StockSource`: `loadOffice()` / `loadArticles()`. Alles wat weet "waar komen
  de artikelen vandaan" zit achter deze interface.
- `CountingRepository`: alle persistentie (kantoren, artikelen, sessies,
  tellingen, geleerde locatiekoppelingen, en welk kantoor laatst
  geselecteerd was). Alles wat weet "waar wordt dit opgeslagen" zit achter
  deze interface.

### application/services/

- `ImportService`: haalt data op via een `StockSource` en splitst dat in
  `prepareImport` (enkel lezen + kijken of dit kantoor al bestaat) en
  `commitImport` (effectief bewaren). Die opsplitsing is er specifiek voor
  multi-kantoor: bij een bestaand kantoor kan de UI eerst een waarschuwing
  tonen in plaats van stilletjes te overschrijven (zie hieronder).
- `CountSessionService`: bepaalt scope per telfrequentie, start sessies,
  genereert initiële (nog niet getelde) `CountEntry`'s voor artikelen die al
  een gekende locatie hebben.
- `CountingService`: slaat een telling op én "leert" tegelijk de
  artikel-locatiekoppeling (spec §9); berekent voortgang.

Domeinregel `domain/sessionScope.ts#requiresOutOfScopeConfirmation` bepaalt
of een telling buiten de sessiescope (bv. een kwartaalartikel tijdens een
maandtelling, via "+ Ander artikel tellen") eerst een bevestiging nodig
heeft. Bewust in `domain/` en niet in de UI-component zelf, zodat het een
pure, apart testbare regel blijft (spec §14: geen businesslogica
rechtstreeks in React-componenten).

Deze services kennen geen React, Excel of Dexie — enkel de ports.

- `ExportService` (v0.2): orkestreert de resultatenexport — haalt sessie,
  kantoor, alle artikelen en tellingen op via `CountingRepository`, berekent
  de review met `domain/review.ts#computeSessionReview`, en geeft dat
  resultaat door aan een `StockResultExporter`. Kent zelf geen Excel.

### application/ports/ (vervolg — v0.2)

- `StockResultExporter`: `exportResults(input) -> ExportedFile`. Alles wat
  weet "in welk bestandsformaat komt het resultaat terecht" zit achter deze
  interface, net zoals `StockSource` dat doet voor import. De input
  (`office`, `session`, `review: SessionReviewSummary`, `allArticles`) is
  altijd al volledig berekend domeindata — een implementatie hiervan mag dit
  enkel naar een bestandsformaat wegschrijven, nooit zelf iets berekenen
  (zie `domain/review.ts` hieronder). Vandaag: `ExcelStockResultExporter`.
  Een latere `EBuddyStockResultExporter` (in bv. `adapters/ebuddy/`)
  implementeert dezelfde interface; enkel `application/container.ts`
  wijzigt.

### domain/review.ts (v0.2)

Alle resultaatberekening voor het reviewscherm en de export: totalen per
sessie, resultaat per artikel (vorige/nieuwe telling, verschillen in aantal
en euro), de filters Alles/Verschil/Controle/Niet geteld, of een sessie
afgerond mag worden, en welke "vorige telling" een artikel bij de volgende
import moet krijgen (`buildNextPreviousCounts`). Bouwt voort op de bestaande
kernregel uit `progress.ts#isArticleFullyCounted` (0-versus-null). Twee
bewust gedocumenteerde aannames, met impact op later werk:

- **"Controle"-filter**: geen exacte definitie meegekregen in de opdracht.
  Geïmplementeerd als "dit artikel heeft een notitie" — vandaag enkel gezet
  door de bestaande "buiten sessiescope"-bevestiging (v0.1.1 §3). Zodra er
  een striktere/andere definitie nodig is (bv. een drempelwaarde op het
  verschil), is dat één predicate in `buildArticleReviewResult` om aan te
  passen.
- **Afronden blijft absoluut**: `CountSessionService.completeSession` gooit
  `SessionIncompleteError` zolang niet elk scope-artikel volledig geteld is,
  zonder "force"-parameter. Bewust: als een latere sprint toch een bewuste
  "afronden met openstaande artikelen"-uitzondering nodig heeft, is dat een
  nieuwe, expliciete beslissing — geen stille bypass.

Handmatige buiten-scope-toevoegingen (v0.1.1 §3) verschijnen wel in de
resultatenlijst (ze zijn al geteld) maar tellen nooit mee in de
scope-totalen en blokkeren nooit het afronden.

### adapters/excel/

Leest een `.xlsx`-bestand met de vaste sheets TELLING / ARTIKEL / CONFIG.
Kolommen worden **op naam** gezocht (`excelHeaderUtils.findHeaderRow`), nooit
op een vast rijnummer — nodig omdat de headerrij van sheet TELLING niet altijd
op dezelfde plek staat. Alle foutmeldingen zijn begrijpelijke Nederlandstalige
zinnen (`ExcelValidationError`), zonder stack traces.

`ExcelStockSource` is de enige plaats die weet dat er ooit een Excelbestand
was. Een latere `EBuddyStockSource` (in bv. `adapters/ebuddy/`) implementeert
dezelfde `StockSource`-interface en de rest van de app hoeft niet te
veranderen — enkel `application/container.ts` (en het importscherm, dat een
concrete bron aanmaakt) wijzigen.

**`ExcelStockResultExporter` (v0.2)** implementeert `StockResultExporter` en
is het spiegelbeeld hiervan bij export: het schrijft de reeds berekende
`SessionReviewSummary` (uit `domain/review.ts`) naar de gestandaardiseerde
sheets TELLING / ARTIKEL / CONFIG / NIEUWE_ARTIKELEN / ARTIKEL_LOCATIES, met
dezelfde header-constantes als de parser (`ARTIKEL_REQUIRED_HEADERS`,
`TELLING_REQUIRED_HEADERS`) zodat een geëxporteerd bestand door de eigen
importer herkend wordt. TELLING en ARTIKEL bevatten *alle* artikelen van het
kantoor (niet enkel de sessiescope): een kwartaalartikel dat deze maand niet
meetelt, mag zijn "vorige telling" niet verliezen bij de volgende import
(`domain/review.ts#buildNextPreviousCounts`).

**Excel portability (production-pilot-readiness sprint)**: `ARTIKEL_LOCATIES`
maakt geleerde `ArticleLocationAssignment`'s machine-leesbaar herimporteerbaar
(zie `parseArtikelLocaties.ts`) — vóór deze sprint bestond dat begrip
uitsluitend lokaal in IndexedDB (zie `docs/DATA_MODEL.md`), waardoor een
volledig lege repository (nieuw toestel/browser) na import niets wist over
waar artikelen normaal verwacht worden. CONFIG kreeg daarbij een nieuwe
"Locatie N ID"-rij per locatie: de stabiele, interne `Location.id`, die
`ExcelStockSource.ts` bij import herkent en gebruikt in plaats van de oude,
positionele afleiding (`${officeId}:loc-${n}`) — zo overleeft een locatie's
identiteit hernoemen/herordenen over een export/import-cyclus heen. Beide
zijn optioneel/backward-compatibel: een bestand van vóór deze sprint mist ze
gewoon en valt terug op het oude gedrag. De bestandsnaam
(`shared/exportFileName.ts#buildExportFileName`, bv.
`"2026-09-30 - Stocktelling Lokeren.xlsx"`) is pure formattering, bewust
buiten `domain/` gehouden. Deze adapter berekent zelf niets — enkel
layout/schrijfwerk, conform spec v0.2 §5 ("schrijf geen businesslogica
rechtstreeks in de Excel-adapter").

### adapters/storage/

`IndexedDbCountingRepository` (Dexie) implementeert `CountingRepository`.
Schema in `db.ts`. Dit is de bron van waarheid voor autosave/herstel: elke
telling wordt onmiddellijk weggeschreven, er is geen aparte "concept"-status.

**Principe voor toekomstige schemawijzigingen.** `db.ts` gebruikt Dexie's
eigen versienummering (`this.version(1).stores({...})`,
`this.version(2).stores({...})`, enz.) — dat is nu al zo opgezet en blijft
de manier om het schema te laten evolueren. Belangrijk daarbij, voor elke
volgende sprint: een nieuwe versie voegt enkel toe of wijzigt wat nodig is
(`stores({...})` in een nieuwe `version()`-blok bevat alleen de
nieuwe/veranderde tabellen, niet de volledige lijst) en verwijdert of
herschept nooit een bestaande tabel. Dexie past dit automatisch en
non-destructief toe bij het openen van de database: bestaande rijen in
`offices`, `articles`, `sessions`, `countEntries` en `assignments` blijven
gewoon staan bij een app-update, ook als de gebruiker een sessie open had.
Enkel wanneer een toekomstige wijziging bestaande records zelf van vorm
moet laten veranderen (bv. een veld hernoemen) is een Dexie-`.upgrade()`-
callback op die versie nodig — dat is vandaag nergens het geval en wordt
niet vooruit gebouwd. Er is dus geen apart migratieframework nodig; Dexie's
ingebouwde versionering volstaat, zolang deze regel gevolgd wordt.

### ui/

Schermen praten met `application/services` (via `application/container.ts`)
voor alle schrijfacties en business-beslissingen. Voor **reactieve reads**
(zodat een scherm automatisch bijwerkt zodra er iets in IndexedDB verandert,
nodig voor autosave/herstel zonder expliciete Save-knop) gebruiken de hooks in
`ui/hooks/useLiveData.ts` `dexie-react-hooks` rechtstreeks op de Dexie-tabellen.

**Aanname / bewust bekende beperking:** dit is de ene plek waar de UI-laag
toch rechtstreeks van Dexie weet, in plaats van enkel van de
`CountingRepository`-interface. Voor v0.1 (enkel IndexedDB, geen backend) is
dat de pragmatische keuze — Dexie's `useLiveQuery` geeft "gratis" live
updates. Zodra er een `EBuddyCountingRepository` komt, moet deze ene file
(`useLiveData.ts`) een equivalent "live" mechanisme krijgen (bv. polling of
een subscription); de rest van de UI blijft ongewijzigd omdat pages nooit
zelf `db` importeren.

## Waarom (nog) geen state-management library

Navigatie is een klein, expliciet getypeerd `Route`-union in `App.tsx` (geen
router-library nodig voor ~7 schermen). Applicatiestatus staat niet in React
state maar in IndexedDB; React state bevat enkel UI-only, wegwerpbare zaken
(actief filter, zoekterm, concept-hoeveelheid vóór bevestigen).

## Belangrijkste aannames (impact op later werk)

1. **Artikelstatus-waarden** (kolom "Artikelstatus") waren niet exact
   gespecificeerd. `domain/frequency.ts#normalizeArticleStatus` herkent een
   aantal gangbare NL-markeringen voor "niet actief"; alles anders telt als
   actief. Als de echte waardenlijst gekend is, is dit één functie om aan te
   passen.
2. **Sheet TELLING** wordt gevalideerd (aanwezigheid + kolommen op naam) maar
   de rijgegevens worden in v0.1 niet gebruikt: de app bouwt haar eigen
   tellingen op in plaats van deze sheet te lezen/muteren. Zie ook
   `docs/DATA_MODEL.md`.
3. **Meerdere kantoren** worden sinds v0.1.1 ondersteund in dezelfde
   installatie (opgelost — was in v0.1 nog een aanname). Het hoofdscherm
   heeft een kantoorwisselaar; welk kantoor laatst actief was, wordt bewaard
   via `CountingRepository#getSelectedOfficeId`/`setSelectedOfficeId` (Dexie-
   tabel `appState`, zie `docs/DATA_MODEL.md`). Alle domeinobjecten waren al
   `officeId`-geprefixed (Article/Location-ID's), dus dit was vooral
   `App.tsx`-navigatie- en importwerk, geen datamodel-wijziging.
4. **"Volledige telling"** sluit geblokkeerde/inactieve artikelen nog steeds
   standaard uit (spec §4); er is geen UI-optie in v0.1 om dat expliciet te
   overschrijven (de domeinfunctie ondersteunt dit al via
   `selectArticlesForSessionType(..., { includeInactive: true })`).
5. **"+ Ander artikel tellen"** zoekt over alle artikelen van het kantoor
   (niet enkel de scope van de huidige telling), zodat een fysiek aanwezig
   maar niet-in-scope artikel toch geregistreerd kan worden. Sinds v0.1.1
   toont dit eerst een bevestiging ("Dit artikel behoort normaal niet tot
   deze telling" — Annuleren/Toch tellen) wanneer het artikel buiten de
   sessiescope valt en er nog geen entry voor bestaat; na bevestigen wordt de
   telling opgeslagen met een automatische notitie. Dit telt niet mee in de
   scope-voortgangsteller van de sessie, maar leert wel de locatie.
6. **Herimport van een bestaand kantoor** (zelfde naam/ID) overschrijft de
   artikelgegevens pas na een expliciete bevestiging op het importscherm
   ("Vervangen en importeren"), en behoudt altijd de (mogelijk door de
   gebruiker aangepaste) locatienamen van het bestaande kantoor. Er wordt
   niets automatisch verwijderd (oude artikelen die niet meer in het nieuwe
   bestand staan, blijven gewoon bestaan) — expliciet opschonen is geen
   v0.1.1-scope.

Zie ook `docs/ROADMAP_LOCATIEBEHEER.md` voor een gedocumenteerde (nog niet
gebouwde) toekomstige module rond locatiebeheer/magazijnherorganisatie.

## Gevonden en opgelost tijdens de v0.1.1-hardeningsprint: datumbug bij import

De echte Excelbestanden (`test-fixtures/`, zie `README.md`) legden een bug
bloot in `adapters/excel/excelValues.ts#toIsoDateString`: de basisdatum kwam
één dag te vroeg binnen (bv. "28-08-2026" werd `"2026-08-27"`). Oorzaak: de
`xlsx`-library bouwt een `Date` op uit een Excel-datumserieel via de
**lokale** tijdzoneconstructor (`new Date(jaar, maand, dag)`), niet via UTC.
De oude code las dit terug met `.toISOString().slice(0, 10)`, wat in élke
tijdzone vóór op UTC (o.a. heel Europa, dus ook Argona's eigen kantoren) een
dag laat terugschuiven. Fix: het datumveld lokaal uitlezen
(`getFullYear`/`getMonth`/`getDate`) in plaats van via UTC. Dit had zonder de
echte testbestanden waarschijnlijk niet aan het licht gekomen, want de
synthetische testdata in `testWorkbook.ts` gebruikte tot dan toe geen echte
`Date`-objecten. Zie `excelValues.test.ts` voor een regressietest die dit
onafhankelijk van de tijdzone van de machine verifieert.

## Centrale read-only historiek

Een tweede, kleine "poort" naast `StockSource`: `CentralHistorySource` (alleen lezen) levert afgeronde historische
tellingen aan `CentralHistorySyncService`, die ze additief in IndexedDB samenvoegt en als echte afgeronde sessies
reconstrueert (gedeelde logica met de Excel-import: `historyReconstruction.ts`). De data staat bewust achter een
beveiligd endpoint (`api/central-history.ts`, toegangscode), niet in `public/`. Zie `docs/CENTRAL_HISTORY.md`.

