# Argona Stocktelling

Tablet-first webapp/PWA om fysieke stock te tellen. v0.1: Excel-import +
tellen + autosave/herstel, volledig lokaal (IndexedDB), geen backend, geen
login. Zie `docs/ARCHITECTURE.md` en `docs/DATA_MODEL.md` voor de opzet en
de belangrijkste aannames.

## Starten

Vereist Node.js 20+ en npm.

```bash
npm install
npm run dev
```

Open de getoonde localhost-URL. Voor een écht tablet-gevoel: open de
devtools, zet op "responsive" en kies een tabletformaat (landscape én
portrait), of open de dev-URL rechtstreeks op een tablet in hetzelfde
netwerk.

## Tests

```bash
npm test          # eenmalig
npm run test:watch
```

Er zijn ook integratietests op echte, door Argona aangeleverde Excelbestanden
(`src/adapters/excel/realFixtures.integration.test.ts`). Die bestanden zelf
staan **niet** in git (zie `.gitignore`) en moeten lokaal aanwezig zijn in
`test-fixtures/` in de projectroot:

```
test-fixtures/
  Stocktelling_Antwerpen_standaard.xlsx
  Stocktelling_Lokeren_standaard.xlsx
  Stocktelling_Damme_standaard.xlsx
```

## Productiebuild

```bash
npm run build     # tsc --noEmit/-b + vite build -> dist/
npm run preview   # dist/ lokaal bekijken
```

## Structuur

```
src/
  domain/        pure business-regels (telfrequentie, voortgang, sortering)
  application/    ports (StockSource, CountingRepository) + services
  adapters/
    excel/        Excel-import (xlsx), header-detectie op naam
    storage/       IndexedDB (Dexie)
  ui/
    components/   herbruikbare, tablet-vriendelijke UI-bouwstenen
    pages/        schermen
    hooks/        reactieve IndexedDB-reads (autosave/herstel)
```

Zie `docs/ARCHITECTURE.md` voor het waarom van deze indeling — met name hoe
de Excel-adapter later door een eBuddy-adapter vervangen kan worden zonder de
telinterface opnieuw te bouwen.
