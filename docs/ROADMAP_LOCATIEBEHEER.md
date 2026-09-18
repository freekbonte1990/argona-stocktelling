# Roadmap — Locatiebeheer & magazijnherorganisatie (toekomstig, NIET bouwen)

Dit document beschrijft enkel een toekomstige module. Niets hieruit is in
v0.1 of v0.1.1 gebouwd — het is bewust alleen documentatie, zodat het huidige
datamodel er rekening mee kan houden zonder de scope van deze sprints te
vergroten.

## Aanleiding

v0.1 werkt met een vaste set van ~5 telzones per kantoor (`Location`,
nummer 1..5) en "leert" via `ArticleLocationAssignment` waar een artikel
normaal ligt (spec v0.1 §9). Zodra een magazijn echt gaat groeien of
herorganiseren, botst dat eenvoudige model op zijn grenzen. Deze module is
waar dat probleem later aangepakt wordt.

## Gewenste functionaliteit (later)

- Nieuwe stocklocaties kunnen toevoegen (niet langer een hard vastgezet
  aantal van 5 per kantoor).
- Een locatie hernoemen (dit kan trouwens al, sinds v0.1 — instellingen).
- Een locatie inactief kunnen maken (zonder ze te verwijderen — historiek
  blijft behouden).
- Een nieuw rek/zone toevoegen wanneer het magazijn uitbreidt.
- Eén of meerdere artikelen naar een andere locatie verplaatsen.
- Een volledige locatie in bulk verplaatsen (bv. bij een grote herschikking).
- Meerdere locaties per artikel blijven mogelijk (dit ondersteunt het
  datamodel via `ArticleLocationAssignment` al sinds v0.1).
- Een eenvoudige telvolgorde van locaties kunnen instellen (in welke
  volgorde locaties getoond worden tijdens het lopen door het magazijn).
- Locatiehistoriek: waar heeft een artikel ooit gelegen, en wanneer is dat
  gewijzigd.
- Tijdens het tellen een voorstel kunnen tonen zoals:
  > "Dit artikel werd vroeger op Locatie 2 geteld. Permanent verplaatsen naar
  > Locatie 4?"
  gebaseerd op de historiek van `ArticleLocationAssignment` (bv. wanneer een
  artikel herhaaldelijk op een andere locatie geteld wordt dan zijn actieve
  koppeling).

## Wat dit betekent voor het huidige datamodel

Geen van bovenstaande punten vereist een breuk met v0.1/v0.1.1:

- `Location` heeft al een los `id`/`number`/`name` — een vast aantal van 5
  is vandaag een aanname in de UI (5 kaarten, CONFIG-sheet met 5
  locatienamen), niet een harde limiet in het domeinmodel zelf. Een
  variabel aantal locaties per kantoor is dus vooral UI- en Excel-adapter
  werk, geen domeinherbouw.
- `ArticleLocationAssignment` heeft al `active` en `lastSeenAt` — "inactief
  maken" en "historiek" passen hier natuurlijk op (bv. door bij een
  verplaatsing de oude koppeling op `active: false` te zetten in plaats van
  te verwijderen, en de nieuwe koppeling toe te voegen).
- Een artikel kan al aan meerdere locaties tegelijk gekoppeld zijn (v0.1).

## Nadrukkelijk niet nu bouwen

Rekken/schappen/plattegronden, bulkverplaatsing-UI, locatiehistoriek-scherm,
en het "vroeger op Locatie X"-voorstel blijven allemaal buiten scope tot dit
expliciet als sprint wordt opgestart.
