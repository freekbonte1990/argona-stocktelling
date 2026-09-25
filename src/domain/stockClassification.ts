import type { Article, StockClassification } from "./types";

/**
 * Sprint 2 (Historical Count Analysis) §5: minimale voorraadclassificatie —
 * ACTIVE/OBSOLETE. Bewust GEEN SLOW_MOVING deze sprint (spec: "niet
 * automatisch afleiden uit maandelijkse snapshots — dat gebeurt pas later
 * op basis van echte eBuddy-bewegingsdata"). De union zelf staat in
 * `domain/types.ts` (zelfde plaats als `ArticleCountFrequency` e.d.); dit
 * bestand bevat enkel de normalisatie-/weergavehulpfuncties, net als
 * `frequency.ts` dat voor `ArticleCountFrequency` doet.
 */

/** Veilige standaardwaarde: elk artikel zonder expliciete classificatie is ACTIEF (nooit fictief OBSOLETE). */
export const DEFAULT_STOCK_CLASSIFICATION: StockClassification = "ACTIVE";

/**
 * Bewust NIET "Actief"/"Inactief" (dat zou botsen met — en verward worden
 * met — `ArticleActiveStatus`/`ARTICLE_STATUS_OPTIONS` op dezelfde
 * artikeldetailpagina, een compleet andere as, zie de uitleg hierboven):
 * "Normale voorraad" maakt het onderscheid met de telbaarheidsstatus
 * meteen duidelijk voor de gebruiker.
 */
export const STOCK_CLASSIFICATION_LABELS: Record<StockClassification, string> = {
  ACTIVE: "Normale voorraad",
  OBSOLETE: "Obsolete",
};

/**
 * DE enige correcte manier om de classificatie van een artikel te lezen —
 * nooit rechtstreeks `article.stockClassification` vergelijken, want dat is
 * `undefined` voor élk artikel dat vóór deze sprint werd aangemaakt/
 * geïmporteerd (spec §14: "veilige standaardwaarde: ACTIVE, tenzij de
 * huidige architectuur een betere expliciete migratie toelaat" — die is er
 * hier niet, dus expliciet ACTIVE). Werkt ook correct op een BEVROREN
 * `Article` binnen een `ArticleSnapshot`/`ArticleReviewResult` van vóór
 * deze sprint (die kende dit veld simpelweg nooit).
 */
export function getStockClassification(
  article: Pick<Article, "stockClassification">,
): StockClassification {
  return article.stockClassification ?? DEFAULT_STOCK_CLASSIFICATION;
}

/**
 * Normaliseert een ruwe (Excel-)tekstwaarde naar `StockClassification` —
 * gebruikt bij het (optioneel) inlezen van kolom "Voorraadclassificatie" in
 * ARTIKEL (zie `adapters/excel/parseArtikel.ts`). Alles wat niet exact
 * "OBSOLETE" is (case-insensitief/getrimd) — inclusief leeg/onbekend — valt
 * terug op ACTIVE, dezelfde conservatieve aanpak als
 * `frequency.ts#normalizeArticleStatus`.
 */
export function normalizeStockClassification(raw: string | null | undefined): StockClassification {
  const value = (raw ?? "").trim().toUpperCase();
  return value === "OBSOLETE" ? "OBSOLETE" : DEFAULT_STOCK_CLASSIFICATION;
}

/** Omgekeerde afbeelding — voor export (kolom "Voorraadclassificatie" in ARTIKEL). */
export const STOCK_CLASSIFICATION_TO_RAW: Record<StockClassification, string> = {
  ACTIVE: "ACTIEF",
  OBSOLETE: "OBSOLETE",
};
