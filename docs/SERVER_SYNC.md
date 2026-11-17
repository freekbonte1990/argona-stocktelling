# Server-opslag van tellingen (Supabase)

Probleem: tot nu toe stond een lopende telling uitsluitend in de browser van één toestel (IndexedDB). Een gesloten privévenster,
een ingebouwde browser, opgeruimde sitegegevens of een ander toestel betekende: telling kwijt.

Oplossing: de app blijft local-first (snel, werkt offline), maar **elk record wordt automatisch naar Supabase gesynchroniseerd**.
Een telling staat dus altijd ook op de server en is op elk toestel zichtbaar.

## Wat wordt gesynchroniseerd

Per kantoor, als JSON-documenten in de tabel `sync_docs`:

| collectie   | inhoud                                                                 |
|-------------|------------------------------------------------------------------------|
| `session`   | tellingen (lopend, geannuleerd, afgerond)                              |
| `entry`     | alle invoeren (aantallen per artikel en locatie)                       |
| `locStatus` | locatie afgerond/open per telling                                      |
| `finalized` | bevroren resultaat (review + snapshot) van afgeronde tellingen         |
| `history`   | HISTORIE-regels van afgeronde tellingen                                |
| `assignment`| gekoppelde artikel-locaties                                            |
| `article`   | enkel lokaal aangemaakte tijdelijke (TMP-)artikelen                    |
| `prev`      | de "vorige telling"-hoeveelheden per artikel                           |

Niet gesynchroniseerd: tellingen die vóór `SERVER_SYNC_FROM` (1 nov 2026, `src/application/container.ts`) gestart zijn en de
centraal gereconstrueerde sessies (`central-…`). Die komen uit de centrale historiek en zouden anders dubbel verschijnen.

## Hoe het werkt

- **Uploaden (push)**: de app vergelijkt zijn lokale documenten met de laatst gesynchroniseerde hashes en stuurt alleen wat wijzigde,
  inclusief "tombstones" voor verwijderde records. Dit gebeurt 2 s na elke wijziging, elke 15 s, bij het zichtbaar worden van de pagina en
  zodra het toestel weer online komt. Mislukt het (geen verbinding), dan blijft alles lokaal staan en probeert de app het opnieuw.
- **Binnenhalen (pull)**: wijzigingen van andere toestellen worden toegepast. Een lokale wijziging die nog niet geüpload is, wint altijd.
- **Statusbalk** onder de header: groen = "Opgeslagen op de server", geel = "Niet opgeslagen op de server (n wijzigingen)". De browser
  waarschuwt bij het sluiten zolang er nog niet-gesynchroniseerde wijzigingen zijn.
- Conflicten: laatste schrijver wint per invoer (een invoer = één artikel op één locatie). Twee mensen die verschillende locaties tellen, botsen niet.

Code: `RemoteSyncService` (application), `SupabaseRemoteStore` (adapters/remote, PostgREST via fetch), `startSyncScheduler`,
`SyncStatusBar`. Port: `RemoteStore`. Een latere eBuddy-API vervangt enkel de adapter.

## Eenmalige opzet (jij)

1. **Supabase-project**: dashboard -> *SQL Editor* -> *New query* -> inhoud van `supabase/schema.sql` plakken -> *Run*.
2. **Sleutels**: *Project Settings* -> *API*: kopieer de *Project URL* en de *anon public* key.
3. **Vercel**: *Project* -> *Settings* -> *Environment Variables* (Production): voeg toe `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` (zie `.env.example`). Daarna opnieuw deployen (*Redeploy*).
4. **Oude data**: op je pc, in de projectmap:
   ```
   set SUPABASE_URL=https://<project-ref>.supabase.co
   set SUPABASE_SERVICE_KEY=<service_role key>
   npm run migrate-central-to-supabase
   ```
   (de service_role-sleutel staat bij *Project Settings* -> *API*; geheim houden, nooit in Vercel/VITE zetten). Daarna leest `/api/central-*`
   uit Supabase; bij een fout of zonder die variabelen vallen de functies automatisch terug op de JSON-bestanden.
   Na elke `publish-central-history`/`publish-central-master` of `apply-central-corrections` het script opnieuw uitvoeren.

## Beperkingen (bewust, voorlopig)

- **Geen aanmelding**: wie de app-URL kent (en dus de publieke sleutel kan vinden), kan data lezen en schrijven. Dit is de bewuste, tijdelijke keuze
  "link openen en tellen". Echte toegangscontrole is de volgende stap (Supabase Auth of eBuddy). De tabel laat geen echt verwijderen toe (alleen tombstones).
- Eén lopende telling per kantoor wordt afgedwongen per toestel; twee toestellen die op exact hetzelfde moment een nieuwe telling starten, kunnen
  allebei een actieve telling hebben. De statusbalk en het binnenhalen bij het openen van de app maken dat zeldzaam.
