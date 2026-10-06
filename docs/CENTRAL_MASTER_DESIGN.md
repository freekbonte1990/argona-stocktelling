# Centrale masterdata — ontwerp (historisch; zie docs/CENTRAL_MASTER.md voor de gebouwde versie)

> Update: de toegangscode/Bearer-beveiliging die in dit ontwerp staat (sectie endpoint, open punt A) is later volledig geschrapt. De app en de endpoints hebben geen authenticatie meer; zie `docs/CENTRAL_MASTER.md`.

Status: het oorspronkelijke ontwerpvoorstel. De beslissingen A–D zijn genomen en de feature is gebouwd; `docs/CENTRAL_MASTER.md` is de actuele beschrijving.

## 1. Datamodel

Nieuw domeintype `CentralMasterFile` (schemaVersion 1), één bestand per kantoor, strikt gevalideerd (alles-of-niets):

```
{
  "schemaVersion": 1,
  "officeId": "lokeren",            // = slugify(kantoornaam), zelfde id als in Excel
  "generatedAt": "2026-10-07T08:00:00.000Z",
  "revision": "9f2c1a7be0d34c11",   // inhoudshash; wijzigt enkel als de inhoud wijzigt
  "office":      { "name": "Lokeren", "baseDate": "2026-09-30" },
  "locations":   [ { "id": "lokeren:loc-1", "number": 1, "name": "Rek A", "active": true } ],
  "categories":  [ { "id": "cat-…", "name": "Kabels", "sortOrder": 3, "active": true } ],
  "articles":    [ {
      "articleNumber": "12345", "officialArticleNumber": null, "idType": "OFFICIEEL",
      "description": "…", "unit": "stuk", "supplier": null, "costPrice": 12.5,
      "categoryId": "cat-…", "sourceProductGroup": "KABELS",
      "countPeriod": "MONTHLY", "rawCountPeriod": "MAAND",
      "status": "ACTIVE", "rawStatus": "ACTIEF",
      "assortmentActive": true, "stockClassification": "ACTIVE" } ],
  "assignments": [ { "articleNumber": "12345", "locationId": "lokeren:loc-1", "active": true } ],
  "deletedArticleNumbers": []        // gereserveerd, in v1 niet toegepast (afwezig ≠ verwijderd)
}
```

Identiteitscontract (kritisch, ook voor eBuddy): `Article.id = officeId:articleNumber`, `Location.id` en `ProductCategory.id` zijn stabiele strings. Alle bestaande tellingen, historiek en koppelingen verwijzen hiernaar.

Niet in de master: `previousCount` (telresultaat), sessies, CountEntries, `comment`.

Eigenaarschap per veld:
- Master-eigen (centraal wint altijd): kantoornaam/basisdatum, locatie id/nummer/naam/actief, categorie id/naam/volgorde/actief, alle artikelstamvelden hierboven.
- Lokaal-eigen (nooit overschreven): sessies, entries, locatiestatussen, `comment`, lokaal aangemaakte TMP-artikelen, historisch-only artikelen uit de centrale historiek.
- Samengevoegd: artikel-locatie-koppelingen (zie 6).

Dexie v9 (additief): tabel `centralMasterStatus: "officeId"` met `{ officeId, revision, lastAttemptAt, lastSuccessAt, lastError, generatedAt, articleIds[], locationIds[], categoryIds[], assignmentIds[] }`. De id-lijsten zijn nodig om "was dit ooit centraal?" te weten, zonder het `Article`-type te wijzigen. Toegangscode: bestaande tabel `centralHistoryConfig` wordt hergebruikt (één code voor historiek en master).

## 2. Endpointstructuur

- `GET /api/central-master` → kantorenindex `{ schemaVersion, offices: [{ id, name, revision, generatedAt, articleCount }] }`
- `GET /api/central-master?officeId=lokeren` → volledige master. Met `If-None-Match: <revision>` → `304` zonder body.
- Nieuwe functie `api/central-master.ts`, data in `central-master-data/<kantoor>.json` (buiten `public/`, via `vercel.json` `includeFiles`).
- Zelfde beveiliging als de historiek: Bearer-code, dezelfde env-variabele `CENTRAL_HISTORY_TOKENS` (geen tweede code), constant-time vergelijking, fail-closed 503, officeId-whitelist, enkel GET, `private, no-store`. Ook de index is beveiligd.
- Auth-blok wordt gedupliceerd (functies blijven zelfstandig, geen relatieve imports); een contracttest bewaakt dat beide endpoints identiek reageren.
- Omvang: Antwerpen ≈ 1.400 artikelen, ruim onder de responslimiet van Vercel.
- Publiceren buiten de app: `npm run publish-central-master -- "<export.xlsx>" [--dry-run]`, hergebruikt de bestaande Excel-parsers en schrijft deterministische JSON (één artikel per regel). Het script controleert dat categorieën met hetzelfde id over alle kantoren dezelfde naam/volgorde/actief-status hebben.

## 3. Bootstrap-flow (nieuw toestel)

1. App opent, geen kantoren lokaal → bootstrap-scherm i.p.v. Excel-import (Excel-import blijft daar als link "Liever een Excelbestand importeren").
2. Toegangscode invoeren (eenmalig; zie open punt A).
3. Kantorenindex ophalen → gebruiker kiest kantoor.
4. Master ophalen → valideren (schema, unieke artikelnummers, verwijzingen naar bestaande locaties/categorieën/artikelen) → in één Dexie-transactie opslaan: kantoor, locaties, categorieën, artikelen, koppelingen, `ImportMeta` ("Centrale master <revision>", want sessies nemen `sourceFileName` hieruit over), `categoriesMigrated: true` (anders zou de bestaande eenmalige productgroep-migratie lokale dubbele categorieën met willekeurige id's aanmaken), `setSelectedOfficeId`.
5. Historiek ophalen via de bestaande `CentralHistorySyncService`.
6. App opent op Home. Mislukt stap 5, dan opent de app toch (de master volstaat om te tellen) en probeert de historiek later opnieuw.
Mislukt stap 4 (offline/401/ongeldig): scherm met begrijpelijke melding, "Opnieuw proberen" en de Excel-fallback; er wordt niets half opgeslagen.

## 4. Update/sync-gedrag (latere starts)

- Op Home-route/kantoorwissel, op de achtergrond, fire-and-forget, throttle 10 min: eerst master, dan historiek. Een mislukte master blokkeert de historiek niet.
- Onveranderde `revision` → 304, niets geschreven.
- Wijziging: pure planfunctie `planCentralMasterApply(lokaal, master, status)` → één transactie. Nooit een `CountEntry` of sessie aanraken; `session.articleIds` en `session.locationIds` zijn al bevroren, dus een lopende telling verschuift niet. Prijs/omschrijving mogen midden in een telling wijzigen (te bevestigen, punt C).
- Artikel dat eerder centraal was en nu ontbreekt → `assortmentActive=false`, nooit verwijderd (zelfde regel als de Excel-import). Idem voor locaties (inactief, nooit verwijderd).
- Lokaal aangemaakte TMP-artikelen en historisch-only artikelen worden nooit gedeactiveerd.
- Eerste sync op een toestel met bestaande Excel-data ("adoptie"): artikelen op id gematcht en overschreven met master-velden; lokale artikelen die niet in de master staan blijven staan (behalve de gewone Excel-diff-regel voor niet-TMP-artikelen: inactief).
- `previousCount`: niet uit de master; wordt na de historiek-sync afgeleid uit de nieuwste afgeronde sessie per artikel, enkel waar het lokaal nog leeg is of de centrale sessie recenter is dan de lokale (punt D).

## 5. Offline gedrag

Na één geslaagde bootstrap werkt alles lokaal uit IndexedDB. Een mislukte sync wijzigt niets lokaals en schrijft enkel `lastError` in `centralMasterStatus` (intern, geen scherm; hoogstens een discrete niet-blokkerende melding). Eerste start zonder verbinding: bootstrap-scherm met retry en Excel-fallback.

## 6. Conflictregels

| Situatie | Regel |
|---|---|
| Master-veld verschilt van lokaal | Centraal wint, altijd |
| Lokale tellingen/sessies | Nooit door master geraakt |
| Artikel ontbreekt in nieuwe master | Inactief in assortiment, niet verwijderd (enkel als het centraal was) |
| Lokaal TMP-artikel | Blijft; nooit gedeactiveerd door sync |
| Locatie lokaal toegevoegd, niet in master | Blijft behouden (CountEntries verwijzen ernaar) |
| Koppeling in beide | Nieuwste `lastSeenAt` wint (bestaande regel `mergeArticleLocationAssignments`); centrale rijen krijgen `lastSeenAt = generatedAt` |
| Koppeling enkel lokaal geleerd | Blijft |
| Centraal beheerd kantoor in de UI | Master-velden, locaties en categorieën read-only (bewerkknoppen verborgen); tellen, TMP-artikelen en koppelingen blijven werken |

## 7. Impact op Excel-import/export

`ImportService`, `StockSource` en export blijven ongewijzigd. Import op een centraal beheerd kantoor krijgt een extra waarschuwing en zet `centralMasterStatus.revision = null`, zodat de volgende sync de master opnieuw toepast. De Excel-export blijft de bron voor `publish-central-master` (rondreis: app → Excel → publicatie).

## 8. Migratiepad naar eBuddy

Port `CentralMasterSource`: `label`, `fetchOfficeIndex()`, `fetchOfficeMaster(officeId, { knownRevision? })` → `{ kind: "unchanged" } | { kind: "master", file: CentralMasterFile }`, fouten via `CentralMasterError` (zelfde soorten als de historiek). Vandaag `HttpCentralMasterSource`; later `EBuddyCentralMasterSource` die eBuddy-DTO's naar `CentralMasterFile` mapt. Wijziging in `container.ts`: één constructieregel (plus één voor historiek). Voorwaarden voor de eBuddy-adapter: (1) artikelnummer blijft de sleutel, zodat `officeId:articleNumber` gelijk blijft; (2) locatie- en categorie-id's stabiel; (3) revision = eBuddy-ETag/updatedAt; (4) per-gebruiker auth hoort bij de eBuddy-adapter zelf. Het publicatiescript en `central-master-data/` verdwijnen dan. Open: omzetting TMP → officieel nummer (veld `supersedesArticleNumber` gereserveerd, niet in v1).

## 9. Tests

- Domein: parser/validator (geldig, onbekend schema, dubbele artikelnummers, ontbrekende verwijzingen, verkeerd kantoor, alles-of-niets), `planCentralMasterApply` (nieuw, gewijzigd, ontbrekend → inactief, TMP ongemoeid, lokale locatie behouden, koppelingsmerge, idempotentie).
- Service: bootstrap (volgorde master → historiek, historiek faalt → app opent), 304, offline, 401, ongeldig bestand laat lokaal ongewijzigd, throttle, in-flight dedupe, lopende sessie ongemoeid.
- Storage: Dexie v8 → v9 migratie, atomaire transactie (fout halverwege → niets geschreven), `categoriesMigrated` voorkomt dubbele categorieën.
- API: auth (401/503/405/400/404/200/304), index beveiligd, path traversal, contracttest met `central-history`.
- Adapter: `HttpCentralMasterSource` (headers, timeout, content-type, 304).
- Integratie: lege device → bootstrap → Analyse/Vergelijken → offline → herhaalde sync zonder dubbels; adoptie van een Excel-toestel; Excel-import op centraal kantoor.
- Publicatiescript: Lokeren-fixture → JSON → deterministisch, categorie-consistentie over kantoren.
- UI: bootstrap-scherm (fouten, retry, Excel-link), read-only gedrag in Instellingen/Artikels voor centraal beheerde kantoren.
- Kostenraming: ~10 nieuwe testbestanden, geen wijziging aan bestaande services behalve `container.ts`, `App.tsx`, `db.ts`, repository-port (+2 methodes), `ProductCategoryService` (respecteert `categoriesMigrated`).

## Open punten (beslissing nodig)

A. Invoer van de toegangscode op een nieuw toestel, nu de Instellingen-sectie weg is.
B. Read-only UI voor master-velden in centraal beheerde kantoren (voorstel: ja) of toch lokale overrides toelaten.
C. Master-wijzigingen toepassen tijdens een lopende telling (voorstel: ja, bevroren sessiescope beschermt de telling).
D. `previousCount` afleiden uit historiek (voorstel) of meegeven in de master.
