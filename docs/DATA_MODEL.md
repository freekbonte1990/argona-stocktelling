# Datamodel — Argona Stocktelling v0.1

Zie `src/domain/types.ts` voor de canonieke TypeScript-definities; dit
document geeft de betekenis en de niet-voor-de-hand-liggende regels.

## Office / Location

Eén `Office` heeft altijd precies 5 `Location`s (1..5), overeenkomstig de
vaste "vijf telzones" uit de opdracht. Locatienamen komen uit sheet CONFIG
(`Locatie N naam`); als zo'n naam leeg is, valt de naam terug op
`"Locatie N"`. Deze namen zijn nadien aanpasbaar via het instellingenscherm
(worden dan rechtstreeks op de bewaarde `Office` bijgewerkt).

## Article

Komt uit sheet ARTIKEL. `articleNumber` is een vrije string — een tijdelijk
nummer zoals `TMP-DAM-0001` is een even geldig ID als een officieel
artikelnummer en wordt nergens geweigerd. `id` = `${officeId}:${articleNumber}`.

`countPeriod` is de genormaliseerde vorm van de ruwe kolom TELPERIODE (zie
`domain/frequency.ts#normalizeFrequency`, case-insensitive):

| Ruwe waarde (Excel) | Genormaliseerd        |
|----------------------|------------------------|
| MAAND                | `MONTHLY`              |
| KWARTAAL             | `QUARTERLY`            |
| JAAR                 | `YEARLY`               |
| NVT                  | `NOT_APPLICABLE`       |
| NOG TE BEPALEN       | `TO_BE_DETERMINED`     |
| (leeg / onbekend)    | `TO_BE_DETERMINED`     |

Alles wat niet herkend wordt, valt bewust op `TO_BE_DETERMINED` in plaats van
stilletjes genegeerd te worden (spec §4): het importscherm toont dit aantal
altijd als aparte categorie, zodat het nooit onopgemerkt blijft.

`status` is de genormaliseerde vorm van "Artikelstatus" (`ACTIVE`/`INACTIVE`
— zie de aanname hierover in `docs/ARCHITECTURE.md`).

## CountSessionType — selectielogica

Zie `domain/frequency.ts#selectArticlesForSessionType`:

| Sessietype  | Neemt artikelen mee met TELPERIODE      |
|-------------|------------------------------------------|
| MONTHLY     | MAAND                                     |
| QUARTERLY   | MAAND, KWARTAAL                           |
| YEARLY      | MAAND, KWARTAAL, JAAR                     |
| FULL        | alle (incl. NVT en NOG_TE_BEPALEN)        |

Geblokkeerde/inactieve artikelen worden bij elk type standaard uitgesloten.
NVT-artikelen komen dus **enkel** mee bij FULL. NOG_TE_BEPALEN-artikelen
komen niet automatisch mee bij MONTHLY/QUARTERLY/YEARLY (ze horen thuis in
een reviewstap, niet stilletjes in een telling) maar mogen wel in FULL zitten.

## CountSession / CountEntry — de kern-invariant

Elke `CountEntry` staat voor **één artikel op één locatie, binnen één
sessie**. De belangrijkste regel van de hele applicatie:

```
quantity = 0    & counted = true   -> geldig geteld resultaat van nul stuks
quantity = null & counted = false  -> nog niet geteld
```

`counted` is altijd de bron van waarheid over "is dit al geteld", nooit
`quantity`. Dit wordt afgedwongen doordat `CountingService.recordCount` de
enige plek is die een `CountEntry` op `counted: true` zet, en dat altijd
samen met een expliciete `quantity` doet.

Een `CountSession` bewaart welke artikelen bij het starten in scope zaten
(`articleIds`) — dat blijft vastliggen, ook als latere Excel-imports de
artikellijst wijzigen.

## ArticleLocationAssignment — locaties leren

Bij de eerste telling van een kantoor is er nog geen betrouwbare
artikel-locatiekoppeling (die stond nooit consistent in Excel). Zodra iemand
een artikel op een locatie telt (`CountingService.recordCount`), wordt hier
een `ArticleLocationAssignment(officeId, articleId, locationId, active=true)`
voor aangemaakt of bijgewerkt. Bij de **volgende** sessie
(`CountSessionService.startSession`) worden op basis hiervan alvast
"nog niet geteld"-`CountEntry`'s aangemaakt voor elk artikel op elke locatie
waar het verwacht wordt — dat is ook meteen de noemer voor de
locatievoortgang ("32 / 87 geteld").

Een artikel kan aan meerdere locaties tegelijk gekoppeld zijn (bv. zowel
Locatie 1 als Locatie 3); er is geen exclusiviteit.

**Update (production-pilot-readiness sprint)**: dit is niet langer
uitsluitend lokale IndexedDB-kennis. Sheet `ARTIKEL_LOCATIES` (zie
`adapters/excel/parseArtikelLocaties.ts`) exporteert/herimporteert alle
assignments (actief én inactief), gematcht op de stabiele `Location.id` (zie
CONFIG's "Locatie N ID"-rij, `adapters/excel/parseConfig.ts`) — zo weet een
volledig lege repository na import onmiddellijk waar elk artikel normaal
verwacht wordt, zonder opnieuw te moeten leren via tellen.

## Voortgang — niet naïef optellen

Omdat één artikel op meerdere locaties kan voorkomen, bestaat er geen
één-op-één relatie tussen "aantal CountEntry's" en "aantal unieke artikelen".
`domain/progress.ts#computeSessionProgress` berekent daarom twee aparte
grootheden:

- **locatie-entry voortgang**: per locatie, hoeveel van de (op dat moment
  gekende) entries geteld zijn — dit is wat op de locatiekaart staat.
- **unieke-artikel voortgang**: een artikel telt pas mee als "afgewerkt" als
  **alle** entries die voor dit artikel binnen deze sessie bestaan geteld
  zijn. Een artikel zonder enige entry (nog nergens geteld) is niet
  afgewerkt.

## Sortering binnen een locatie (spec §12)

1. Verwacht op deze locatie (actieve `ArticleLocationAssignment`) eerst
2. Productgroep (alfabetisch)
3. Omschrijving (alfabetisch)

Zie `domain/sorting.ts#sortArticlesForLocation`.

## Meerdere kantoren (v0.1.1)

Er is geen apart "multi-tenant"-model nodig: elk `Office` had van bij v0.1 al
zijn eigen `id`, en `Article`/`Location`/`ArticleLocationAssignment`-ID's zijn
allemaal `officeId`-geprefixed. Sessies en tellingen horen bij één
`CountSession`, die op zijn beurt één `officeId` heeft. Twee kantoren delen
dus nooit een rij in dezelfde tabel.

Wat v0.1.1 toevoegt is puur UI-gemak: een `appState`-tabel met één rij die
onthoudt welk kantoor de gebruiker laatst geselecteerd heeft
(`getSelectedOfficeId`/`setSelectedOfficeId` op `CountingRepository`), zodat
een refresh niet terugvalt op "het eerste geïmporteerde kantoor" maar op
"het kantoor waar je net was". Dit is geen businessdata, enkel een
voorkeur.

Een herimport van een kantoor met dezelfde naam (= zelfde `officeId`)
overschrijft nooit stilletjes: `ImportService.prepareImport` detecteert dit
en de UI toont een expliciete keuze. Bij bevestigen blijven de bestaande
(mogelijk aangepaste) locatienamen behouden; enkel artikelgegevens en
basisdatum worden vervangen.

## Sessiescope-bevestiging (v0.1.1)

`domain/sessionScope.ts#requiresOutOfScopeConfirmation` bepaalt of een
telling via "+ Ander artikel tellen" eerst een waarschuwing nodig heeft: dat
is zo wanneer het artikel niet in `CountSession.articleIds` zit (dus buiten
de telfrequentie-scope valt, bv. een kwartaalartikel tijdens een
maandtelling) én er nog geen `CountEntry` voor bestaat op deze locatie. Na
bevestiging ("Toch tellen") wordt de telling gewoon als normale `CountEntry`
opgeslagen — er is geen apart "handmatige toevoeging"-veld in het
datamodel, enkel een automatische notitie ter traceerbaarheid. Zo'n telling
telt niet mee in `totalUniqueArticles`/`completedUniqueArticles` (die zijn
en blijven gebaseerd op `articleIds`), maar wel in de locatie-entry-tellingen
en leert wel de locatie via `ArticleLocationAssignment`.

## Sheet TELLING — bewuste beperking in v0.1

Sheet TELLING wordt bij import volledig gevalideerd (aanwezig, alle kolommen
op naam vindbaar — inclusief de vijf LOCATIE-kolommen), maar de rijgegevens
worden niet overgenomen in het domeinmodel. De reden: TELLING is in de
huidige Excel-werkwijze net het blad dat deze app vervangt. Artikeldata komt
uit ARTIKEL, config uit CONFIG. Als een latere sprint toch met TELLING-data
wil werken (bv. als extra bron voor "vorige telling per locatie"), is de
parser (`adapters/excel/parseTelling.ts`) het startpunt — de headerdetectie
is al herbruikbaar.
