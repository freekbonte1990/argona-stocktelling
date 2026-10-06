# Centrale masterdata

Status: gebouwd (nog niet gecommit/getagd — wacht op review). Bouwt voort op de centrale historiek (`docs/CENTRAL_HISTORY.md`).

**Autoriteit**

- De centrale **master** is autoritatief voor *actuele masterdata*: kantoor, locaties, productgamma's, artikelen (omschrijving, eenheid, kostprijs, bronproductgroep, assortiment, telfrequentie) en artikel-locatiekoppelingen.
- De centrale **historiek** is autoritatief voor *tellingen*. De master bevat daarom nooit tellingen, sessies, opmerkingen of `previousCount`.

Een nieuw toestel hoeft dus geen Excel-master meer te importeren: kantoor kiezen → master → historiek → alles werkt lokaal in IndexedDB.

## Bootstrap-flow (eerste start)

1. Geen kantoor lokaal → `BootstrapPage` (in plaats van de Excel-import).
2. Kantorenlijst ophalen (`GET /api/central-master`) → het scherm "Kies je kantoor". **Geen toegangscode, login of auth-scherm**: de app vraagt niets.
3. Kantoor kiezen.
4. `CentralDataSyncService.bootstrapOffice`: master ophalen → valideren (alles-of-niets) → in **één Dexie-transactie** toepassen → historiek ophalen → "Vorige telling" afleiden uit de historiek → app opent op Home.
5. Mislukt de master (offline/ongeldig/niet gepubliceerd): foutmelding + "Opnieuw proberen"; er wordt niets opgeslagen. Mislukt enkel de historiek, dan opent de app toch (de master volstaat om te tellen) en probeert een latere sync de historiek opnieuw.
6. "Liever een Excelbestand importeren" blijft altijd beschikbaar als fallback. Vanaf het tweede kantoor ("+ Ander kantoor toevoegen") is er ook "Annuleren".

Daarna werkt het toestel lokaal/offline verder; de achtergrond-sync houdt master en historiek bij. Een HTTP 401/403 (bv. van een host-bescherming) wordt gewoon als "niet bereikbaar" getoond — nooit als auth-melding.

## Update/sync-gedrag

- Achtergrond, fire-and-forget, throttle 10 min, vanuit Home: master → historiek → "Vorige telling" afleiden. Een mislukte master blokkeert de historiek niet en omgekeerd; er wordt nooit iets gegooid.
- Onveranderde `revision` → HTTP 304 (`If-None-Match`) → niets geschreven.
- Wijziging → pure `planCentralMasterApply` → `CountingRepository.applyCentralMaster` (één transactie over `offices`, `articles`, `assignments`, `productCategories`, `importMeta`, `appState`, `centralMasterStatus`). Die transactie kan structureel **niet** aan `sessions`, `countEntries`, `locationSessionStatuses`, `finalizedSessionResults`, `historicalSheets` of `stockHistoryEntries` (bewezen met tests).
- Afgeronde tellingen en hun bevroren resultaat worden nooit gemuteerd; een latere master wijzigt enkel de *levende* stam.

### Actieve telling tijdens een master-update (beslissing C)

De master wordt wel opgehaald en gevalideerd, maar **volledig uitgesteld** zolang er een actieve telling is: niets wordt toegepast (ook geen "Vorige telling"-afleiding). De revision komt in `pendingRevision`. Zodra de telling is afgerond of geannuleerd, past de eerstvolgende sync ze toe (de throttle wordt omzeild zolang er iets wacht). Reden: CountingPage, LocationOverview en "Zonder locatie" lezen koppelingen, `office.locations` en artikelvelden live; alleen een volledige uitstel garandeert dat de scope en de getoonde waarden van de lopende telling niet verschuiven. Nieuwe masterdata geldt dus pas voor de volgende telling.

## Read-only gedrag (beslissing B)

Voor een centraal beheerd kantoor (`centralMasterStatus.appliedAt != null`):

- Locaties en productgamma's die centraal zijn: geen toevoeg-, hernoem-, (de)activeer-, volgorde- of verwijderacties in Instellingen.
- Centrale artikelen: geen "Bewerken" in Artikeldetail ("Centraal beheerd — alleen-lezen").
- Bulkacties "Productgamma wijzigen" en "Assortiment wijzigen" zijn verborgen.
- Blijft werken: tellen, lokale koppelingen leren/verplaatsen, opmerkingen, **tijdelijke TMP-artikelen** (aanmaken en bewerken) en lokaal toegevoegde locaties/productgamma's.

## Productgamma-migratie

`ProductCategoryService.ensureMigrated` keert vroeg terug zodra een kantoor centraal beheerd is, ook als `Office.categoriesMigrated` door een Excel-import verloren ging. De master zet zelf `categoriesMigrated: true`. Een lokaal (willekeurig gegenereerd) productgamma met dezelfde **naam** als een centraal productgamma maar een ander id wordt samengevoegd: artikelen van alle kantoren verwijzen voortaan naar het centrale id, het lokale dubbele gamma verdwijnt. Het publicatiescript stemt productgamma's tussen kantoren af op naam (zelfde naam = zelfde id; zelfde id met andere naam = harde fout).

## Conflictregels

| Situatie | Regel |
|---|---|
| Master-veld verschilt van lokaal | Centraal wint |
| Sessies, tellingen, bevroren resultaten, historiek | Nooit geraakt |
| `previousCount`, `comment` | Nooit uit de master; `previousCount` uitsluitend uit de historiek |
| Artikel ontbreekt in nieuwe master | `assortmentActive=false` (alleen als het centraal was, of bij adoptie van een Excel-toestel voor niet-TMP/niet-historische artikelen); nooit verwijderd |
| Lokaal TMP-artikel | Nooit overschreven, gedeactiveerd of verwijderd |
| Centrale locatie verdwijnt | Inactief, nooit verwijderd |
| Lokale locatie die niet centraal is | Blijft; hernummerd na het hoogste masternummer bij botsing |
| Koppeling in beide | Nieuwste `lastSeenAt` wint (centrale rij = `generatedAt`) |
| Koppeling enkel lokaal geleerd | Blijft |

## Endpoint & toegang

`api/central-master.ts` (Vercel Function), zelfde aanpak als de historiek, maar **zonder authenticatie** (bewuste keuze, tijdelijk tot eBuddy): geen code, token of omgevingsvariabele; een meegestuurde `Authorization`-header wordt genegeerd. Wél: `officeId`-whitelist (geen path traversal), enkel GET (405), `private, no-store`, ETag = revision. De data staat in `central-master-data/` (buiten `public/`, gebundeld via `vercel.json` `includeFiles`) en niet in de frontendbundle — maar is via de functie leesbaar voor iedereen met de URL (incl. kostprijzen en artikelen). Echte toegangscontrole komt met eBuddy.

## Publiceren

```
npm run publish-central-master -- "<export.xlsx>" [--out central-master-data] [--include-temporary] [--dry-run]
```

Leest een Argona-Excelbestand, bouwt het gevalideerde bestand (zelfde parser als de app), sluit TMP-artikelen standaard uit, stemt productgamma's af op reeds gepubliceerde kantoren, berekent een inhoudshash als `revision` (niets herschreven als die ongewijzigd is) en schrijft deterministische JSON (één regel per item → kleine git-diffs). Daarna: `git diff` nakijken, committen en pushen; Vercel deployt.

## Migratiepad eBuddy

De port `CentralMasterSource` (`fetchOfficeIndex`, `fetchOfficeMaster(officeId, { knownRevision })`) wordt vandaag door `HttpCentralMasterSource` geïmplementeerd. Een `EBuddyCentralMasterSource` vervangt die in `application/container.ts` (één constructieregel). Voorwaarden: `articleNumber` blijft de sleutel (`Article.id = officeId:articleNumber`), stabiele locatie-/categorie-id's, `revision` = ETag/`updatedAt`-hash, per-gebruiker authenticatie hoort dan bij de eBuddy-adapter zelf. Het publicatiescript en `central-master-data/` verdwijnen dan. Open: omzetting TMP → officieel artikelnummer is niet geïmplementeerd.

## Bekende beperkingen

- Een analyse groepeert historische tellingen per *huidig* productgamma van het artikel (bestaand gedrag); een centrale gammawijziging verschuift dus de groepering, maar muteert nooit een snapshot of sessie.
- Een Excel-toestel (kantoor zonder centrale master) krijgt geen automatische master-overschrijving; het wordt pas "centraal beheerd" na een bewuste bootstrap via "+ Ander kantoor toevoegen".
- PWA op iPad: nieuwe versies vereisen twee volledige herstarts van de app.
