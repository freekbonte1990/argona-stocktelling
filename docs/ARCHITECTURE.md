# Architectuur — Argona Stocktelling (v0.1 + v0.1.1 hardening)

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
    ports/            <- interfaces (StockSource, CountingRepository)
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
