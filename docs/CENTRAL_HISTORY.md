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
 Toestel (PWA)  ──GET + toegangscode──►  api/central-history.ts  (serverless, controleert de code)
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
- **Opslag (Dexie v8)**: tabellen `centralHistoryStatus` (per kantoor) en `centralHistoryConfig` (toegangscode van dit toestel). Puur additief.

## Beveiliging (waarom een functie en geen statisch bestand)

De productie-app op Vercel is publiek bereikbaar zonder aanmelding. **Alles in `public/` of `dist/` is voor iedereen leesbaar.** Aantallen en kostprijzen staan daarom
nooit als statisch bestand online. Een private GitHub-repository beschermt geen gedeployde assets; de toegangscontrole zit in de functie:

- Data staat in `central-history-data/` (buiten `public/`, dus niet in `dist/`) en wordt via `vercel.json` → `includeFiles` enkel in `api/central-history.ts` gebundeld.
- Elke aanvraag moet `Authorization: Bearer <toegangscode>` meesturen. Geldige codes staan in de Vercel-omgevingsvariabele `CENTRAL_HISTORY_TOKENS` (kommagescheiden → rotatie zonder onderbreking).
- **Faalt gesloten**: zonder (of met te korte, < 16 tekens) configuratie antwoordt het endpoint 503, nooit data.
- Vergelijking in constante tijd, `officeId` strikt `[a-z0-9-]` (geen path traversal), alleen GET, antwoorden `private, no-store`.
- De service worker laat `/api` buiten de navigatiefallback (`navigateFallbackDenylist`) en precachet geen json; na één geslaagde sync zit alles in IndexedDB.

De toegangscode staat op elk toestel in IndexedDB (Instellingen → Centrale historiek). Wie een toestel verliest: code roteren (nieuwe code toevoegen aan `CENTRAL_HISTORY_TOKENS`, oude verwijderen, toestellen opnieuw instellen).

> Beperking: dit is één gedeelde toegangscode voor Argona-gebruik, geen persoonlijke accounts. Voor per-gebruiker toegang is de eBuddy-API de aangewezen weg (zie migratiepad).

## Eenmalige opzet

1. Genereer een code: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Vercel → Project → Settings → Environment Variables: `CENTRAL_HISTORY_TOKENS` = de code (Production én Preview). Redeploy.
3. Publiceer de historiek (zie hieronder), commit en push.
4. Per toestel: Instellingen → Centrale historiek → toegangscode invoeren → "Opslaan en synchroniseren".

Lokaal testen: `vite dev` heeft geen `/api`; de app toont dan "niet beschikbaar" en werkt gewoon door. Gebruik `vercel dev` om het endpoint lokaal uit te proberen (met `CENTRAL_HISTORY_TOKENS` in de omgeving).

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

Bij het openen van de app en bij elke kantoorwissel (op de achtergrond, max. om de 10 minuten, of handmatig via "Nu synchroniseren"):

- **Additief/idempotent**: lokaal wint bij een botsing op (sessienaam, artikel); sessies krijgen hun stabiele `sourceSessionId` (geen dubbels, ook niet over toestellen heen); een lokale sessie wordt nooit verwijderd omdat ze centraal ontbreekt.
- **Afwezig ≠ verwijderd.** `deletedSessionIds` (tombstones) wordt al geparsed maar in v1 bewust **niet toegepast**.
- **Falen blokkeert nooit**: netwerk/401/ongeldig bestand → discrete melding in Instellingen; lokale data blijft ongewijzigd. Offline werkt alles na één geslaagde sync.
- Onbekende artikelen in centrale regels worden als historisch/inactief artikel aangemaakt (nodig voor snapshots), een bestaand artikel wordt nooit overschreven.

## Verwijderen en corrigeren

- Centraal gesynchroniseerde sessies zijn **read-only qua verwijdering** in de gewone app (service-laag: `CentralSessionDeletionNotAllowedError`; in Instellingen verdwijnt de knop). Anders zou een lokaal verwijderde sessie bij de volgende sync terugkeren.
- Correctie/verwijdering gebeurt aan de centrale bron. **Let op (v1):** al gesynchroniseerde regels worden door de sync nooit overschreven (lokaal wint). Een gecorrigeerde waarde bereikt dus enkel nieuwe toestellen; voor bestaande toestellen is een expliciete tombstone + nieuwe sessie nodig — dat is precies waar `deletedSessionIds` voor gereserveerd is (volgende stap).

## Migratiepad naar eBuddy

Een `EBuddyCentralHistorySource` implementeert dezelfde poort (`fetchOfficeHistory`, resultaat = `CentralHistoryFile`). In `application/container.ts` wordt enkel de ene regel
`new HttpCentralHistorySource(...)` vervangen. Sync-service, repository, Analyse en Vergelijken blijven ongewijzigd; het publish-script, `api/` en `central-history-data/` kunnen dan vervallen.
