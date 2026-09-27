import type { Article } from "./types";

/**
 * Sprint 3.3 §1 — Office assortment / active scope. PURE domeinlogica voor
 * de "hoort dit artikel nog tot het huidige assortiment van zijn kantoor"-as
 * (`Article.assortmentActive`, zie domain/types.ts voor de volledige
 * uitleg/afbakening t.o.v. `status`/`stockClassification`).
 */

/** Veilige standaardwaarde: elk artikel zonder expliciete waarde is ACTIEF (nooit fictief inactief/verborgen). */
export const DEFAULT_ASSORTMENT_ACTIVE = true;

/**
 * DE enige correcte manier om te lezen of een artikel actief is in het
 * assortiment van zijn kantoor — nooit rechtstreeks `article.assortmentActive`
 * vergelijken, want dat is `undefined` voor elk artikel van vóór deze sprint
 * (of nog niet expliciet geclassificeerd). Zelfde patroon als
 * `domain/stockClassification.ts#getStockClassification`.
 */
export function isArticleActiveInAssortment(article: Pick<Article, "assortmentActive">): boolean {
  return article.assortmentActive ?? DEFAULT_ASSORTMENT_ACTIVE;
}

/**
 * Bulk-toepassing (Artikels-overzicht, spec §1: "bulk add/remove office
 * assignment"): geeft enkel NIEUWE, bijgewerkte kopieën terug van de
 * geselecteerde artikelen — puur, schrijft niets. De aanroeper (UI/service)
 * is verantwoordelijk voor het effectief bewaren via de repository.
 */
export function applyAssortmentActive(
  articles: Article[],
  articleIds: ReadonlySet<string>,
  active: boolean,
): Article[] {
  return articles
    .filter((article) => articleIds.has(article.id))
    .map((article) => ({ ...article, assortmentActive: active }));
}

export interface AssortmentImportDiffResult {
  /**
   * De artikelen van DEZE import, elk met `assortmentActive` expliciet
   * opgelost: de waarde uit het bestand (optionele Excel-kolom "Assortiment
   * actief", zie adapters/excel/parseArtikel.ts) wanneer aanwezig, anders
   * `true` — spec §1: "aanwezig in het huidige master-bestand = actief".
   */
  incomingArticles: Article[];
  /**
   * Eerder gekende artikelen van dit kantoor die in DEZE import ONTBREKEN —
   * ongewijzigd, behalve `assortmentActive: false` (spec §1: "verdwenen uit
   * het huidige master = niet meer telbaar, geschiedenis blijft bestaan").
   * Artikelen die al inactief waren, komen hier bewust niet opnieuw in terug
   * (geen onnodige herschrijving) — zie `isArticleActiveInAssortment`.
   *
   * Bewust leeg voor een gloednieuw kantoor (er is dan simpelweg niets
   * "eerder gekend" om te vergelijken) en — cruciaal — ook (nagenoeg) leeg
   * bij een herimport van een EIGEN eerder geëxporteerd archief: zo'n
   * bestand bevat in ARTIKEL per constructie altijd het VOLLEDIGE lokale
   * artikelbestand (actief + al-inactief, zie ExcelStockResultExporter),
   * dus er ontbreekt dan simpelweg niets — deze diff is dan een no-op, geen
   * regressie op de bestaande fresh-repository-roundtrip-garantie.
   */
  newlyInactiveArticles: Article[];
}

export function computeAssortmentImportDiff(
  previousArticles: Article[],
  incomingArticles: Article[],
): AssortmentImportDiffResult {
  const incomingIds = new Set(incomingArticles.map((article) => article.id));
  const resolvedIncoming = incomingArticles.map((article) => ({
    ...article,
    assortmentActive: article.assortmentActive ?? true,
  }));
  const newlyInactiveArticles = previousArticles
    .filter((article) => !incomingIds.has(article.id) && isArticleActiveInAssortment(article))
    .map((article) => ({ ...article, assortmentActive: false }));
  return { incomingArticles: resolvedIncoming, newlyInactiveArticles };
}
