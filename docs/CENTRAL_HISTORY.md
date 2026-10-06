# Centrale read-only historiek

Doel: afgeronde historische tellingen (incl. legacy-periodes) één keer centraal
beschikbaar maken, zodat **elk nieuw toestel ze automatisch krijgt** — zonder
elke keer oude Excelbestanden te moeten importeren, en zonder realtime cloud-sync.
Actieve tellingen blijven volledig lokaal (IndexedDB, local-first).

## Architectuur in één blik

```
 Excel-export (app)  ──►  npm run publish-central-history  ──►  central-history-data/<kantoor>.json
                                                                      │  (git push → Vercel deploy)
                                                                      ▼
 Toestel (PWA)  ──GET (zonder authenticatie)──►  api/central-history.ts  (serverless, alleen-lezen)
      │
      ▼
 HttpCentralHistorySource ─► CentralHistorySyncService ─► IndexedDB (sessies + HISTORIE)
                                                              │
                                                              ▼
                                               Analyse / Vergelijken (ongewijzigd)
```

- **Port**: `application/ports/CentralHistorySource.ts` — enkel lezen (`fetchOfficeHistory`). Er bestaat vanuit de app geen publiceermethode.
- **Adapter vandaag**: `adapters/centralHistory/HttpCentralHistorySource.ts`.
- **Sync**: `application/services/CentralHistorySyncService.ts` (additief, idempotent, gooit nooit).
- **Sessie-reconstructie**: `application/services/historyReconstruction.ts`, gedeeld met de Excel-import. Gereconstrueerde sessies zijn echte COMPLETED-sessies met `FinalizedSessionResult`, dus Analyse en Vergelijken werken ongewijzigd.
- **Opslag (Dexie v8)**: tabel `centralHistoryStatus` (per kantoor). Puur additief. (De tabel `centralHistoryConfig` uit v8 — de oude toegangscode — wordt door v10 verwijderd.)

## Toegang (waarom een functie en geen statisch bestand)

De productie-app op Vercel is publiek bereikbaar zonder aanmelding. **Alles in `public/` of `dist/` is voor iedereen leesbaar.** Aantallen en kostprijzen staan daarom
nooit als statisch bestand online, maar worden door een alleen-lezen functie geserveerd.

**Bewuste keuze: het endpoint heeft GEEN authenticatie** (geen toegangscode, token of login). Wie de URL kent, kan de data lezen. Dat is een tijdelijke, aanvaarde situatie tot eBuddy de bron wordt en daar de echte toegangscontrole zit. Wat de functie wél afdwingt:

- Data staat in `central-history-data/` (buiten `public/`, dus niet in `dist/`) en wordt via `vercel.json` → `includeFiles` enkel in `api/central-history.ts` gebundeld.
- Geen `Authorization`-header nodig (een meegestuurde header wordt genegeerd); geen omgevingsvariabelen nodig.
- `officeId` strikt `[a-z0-9-]` (geen path traversal), alleen GET (405 voor de rest), antwoorden `private, no-store`.
- De service worker laat `/api` buiten de navigatiefallback (`navigateFallbackDenylist`) en precachet geen json; na één geslaagde sync zit alles in IndexedDB.

Er is bewust GEEN scherm in Instellingen om de sync-status of een handmatige synchronisatie te tonen: de sync loopt automatisch op de achtergrond, en een nieuw toestel haalt de historiek op tijdens de bootstrap (zie `docs/CENTRAL_MASTER.md`). Er is geen code of login in de app.

> Beperking: de data is leesbaar voor iedereen met de URL. Echte toegangscontrole (per gebruiker) hoort bij de eBuddy-API (zie migratiepad); daarvoor is in deze app bewust niets voorbereid.

## Eenmalige opzet

1. Publiceer de historiek (zie hieronder), commit en push — Vercel deployt.
2. Per toestel is er niets in te stellen: het bootstrap-scherm (of de achtergrond-sync) haalt de historiek automatisch op.

Lokaal testen: `vite dev` heeft geen `/api`; de app toont dan "niet beschikbaar" en werkt gewoon door. Gebruik `vercel dev` om het endpoint lokaal uit te proberen.

> Opruiming: de omgevingsvariabele `CENTRAL_HISTORY_TOKENS` in Vercel is niet meer nodig en mag verwijderd worden.

## Publiceren (alleen buiten de app)

```
npm run publish-central-history -- "<export.xlsx>" [--dry-run] [--replace] [--out central-history-data]
```

Het script leest een rollend Argona-Excelbestand (de export uit de app, met HISTORIE-sheet), voegt het **additief** samen met het reeds gepubliceerde bestand en schrijft
`central-history-data/<kantoor>.json` (deterministisch, één regel per entry → kleine git-diffs). Regels van een echte sessie zonder `sourceSessionId` (export van vóór v0.9)
krijgen een deterministisch afgeleid ID. Een eenmaal gepubliceerd sessie-ID wijzigt nooit. Daarna: `git diff` nakijken, committen, pushen; Vercel publiceert.

## JSON-schema v1

```json
{
  "schemaVersion": 1,
  "officeId": "damme",
  "generatedAt": "2026-10-01T12:00:00.000Z",
  "deletedSessionIds": [],
  "entries": [ { "countDate": "2026-08-31", "sessionType": "MONTHLY", "sessionName": "2026-08 Maand",
                 "articleId": "damme:A1", "articleNumber": "A1", "description": "…",
                 "totalCount": 10, "previousCount": 4, "differenceQuantity": 6,
                 "costPrice": 2, "differenceAmount": 12, "status": "GETELD",
                 "locationNames": ["Rek 1"], "source": "APP", "sourceSessionId": "…" } ]
}
```

Verplicht: `schemaVersion`, `officeId`, `generatedAt`, `entries`. Validatie is alles-of-niets (`domain/centralHistoryFile.ts`); een bestand voor een ander kantoor of met een nieuwere `schemaVersion` wordt geweigerd.

## Sync-regels

Bij het openen van de app en bij elke kantoorwissel (op de achtergrond, max. om de 10 minuten; er is geen handmatige knop):

- **Additief/idempotent**: lokaal wint bij een botsing op (sessienaam, artikel); sessies krijgen hun stabiele `sourceSessionId` (geen dubbels, ook niet over toestellen heen); een lokale sessie wordt nooit verwijderd omdat ze centraal ontbreekt.
- **Afwezig ≠ verwijderd.** `deletedSessionIds` (tombstones) wordt al geparsed maar in v1 bewust **niet toegepast**.
- **Falen blokkeert nooit**: netwerk/401/ongeldig bestand → status/foutmelding enkel intern bewaard (`centralHistoryStatus.lastError`, geen scherm); lokale data blijft ongewijzigd. Offline werkt alles na één geslaagde sync.
- Onbekende artikelen in centrale regels worden als historisch/inactief artikel aangemaakt (nodig voor snapshots), een bestaand artikel wordt nooit overschreven.

## Verwijderen en corrigeren

- Centraal gesynchroniseerde sessies zijn **read-only qua verwijdering** in de gewone app (service-laag: `CentralSessionDeletionNotAllowedError`; in Instellingen verdwijnt de knop). Anders zou een lokaal verwijderde sessie bij de volgende sync terugkeren.
- Correctie/verwijdering gebeurt aan de centrale bron. **Let op (v1):** al gesynchroniseerde regels worden door de sync nooit overschreven (lokaal wint). Een gecorrigeerde waarde bereikt dus enkel nieuwe toestellen; voor bestaande toestellen is een expliciete tombstone + nieuwe sessie nodig — dat is precies waar `deletedSessionIds` voor gereserveerd is (volgende stap).

## Migratiepad naar eBuddy

Een `EBuddyCentralHistorySource` implementeert dezelfde poort (`fetchOfficeHistory`, resultaat = `CentralHistoryFile`). In `application/container.ts` wordt enkel de ene regel
`new HttpCentralHistorySource(...)` vervangen. Sync-service, repository, Analyse en Vergelijken blijven ongewijzigd; het publish-script, `api/` en `central-history-data/` kunnen dan vervallen.

## Legacy periodes als "Historische snapshot" (Home → Vorige tellingen)

Legacy periodes (`source: "LEGACY_IMPORT"`, status `LEGACY`) zijn **nooit** een `CountSession`. Home toont ze toch samen met de echte app-tellingen, in één chronologische lijst (nieuwste eerst; bij dezelfde dag staat de echte telling boven de legacy), met de teller van beide samen (bv. 1 app-telling + 7 legacy = "Vorige tellingen (8)"). Een item heet `01/09/2026 — Historische snapshot`.

- Model: `domain/legacySnapshotView.ts` (`listLegacySnapshotItems`, `buildPreviousCountList`, `buildLegacySnapshotView`) — puur presentatie, afgeleid uit de `StockHistoryEntry`-regels; id = `legacy:<periode>` (zelfde schema als Vergelijken).
- Detail (alleen-lezen): `LegacySnapshotPage` — periode, kantoor, totale voorraadwaarde, artikels, productgamma's, "Vergelijken" en "Exporteren naar Excel". Hergebruikt `ComparisonService#getLegacyPeriodSnapshot` → `buildLegacyPeriodSnapshot`.
- Export: `LegacySnapshotService#exportToExcel` → `ExcelLegacySnapshotExporter` (los bestand met INFO-blad + datablad). Uitsluitend de ORIGINELE historische hoeveelheid en kostprijs van die periode (waarde = hoeveelheid × historische kostprijs); `Article.costPrice` wordt nergens gelezen. Raakt het rollend archief niet.
