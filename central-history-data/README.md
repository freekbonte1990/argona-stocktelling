# central-history-data

Centrale, **niet-publieke** stockhistoriek (aantallen + kostprijzen), één bestand per kantoor: `<officeId>.json`.

- Deze map staat bewust **buiten `public/`**: alles in `public/` of `dist/` is voor iedereen op het internet leesbaar.
- De bestanden worden enkel in de serverless functie `api/central-history.ts` gebundeld (`vercel.json` → `includeFiles`) en worden alleen-lezen en zonder authenticatie geserveerd (leesbaar voor iedereen met de URL; echte toegangscontrole komt met eBuddy).
- Genereren: `npm run publish-central-history -- <export.xlsx>` — zie `docs/CENTRAL_HISTORY.md`.
- Niet met de hand bewerken.
