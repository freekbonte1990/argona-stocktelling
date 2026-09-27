import type { Article } from "./types";
import type { StockSnapshot } from "./stockSnapshot";

/**
 * Sprint 3.3 §5 (veilig verwijderen van tellingen/snapshots): PURE
 * domeinlogica die, gegeven de bevroren StockSnapshot van een sessie die
 * verwijderd gaat worden en de bevroren StockSnapshots van alle OVERBLIJVENDE
 * afgeronde sessies van hetzelfde kantoor, precies bepaalt welke artikelen
 * hun `previousCount`-baseline moeten herberekenen — en naar welke waarde.
 *
 * Bewust hier in domain/ (niet in de repository/adapter): dit is een pure
 * berekening op reeds bewaarde, bevroren snapshotdata, net als
 * `domain/review.ts#buildNextPreviousCounts` waarvan dit de "omgekeerde"
 * tegenhanger is (dat bouwt de VOLGENDE baseline op bij het AFRONDEN van een
 * sessie; dit bouwt de baseline opnieuw op nadat een sessie is VERDWENEN).
 *
 * Kernregel: `Article.previousCount` moet altijd de laatst bekende ECHTE
 * fysieke telling weerspiegelen (status GETELD of "0 BEVESTIGD" — nooit een
 * OVERGENOMEN/"OVERGENOMEN - NIET GETELD"-rij, want die droeg zelf nooit een
 * nieuwe fysieke telling bij, zie `domain/stockSnapshot.ts#buildArticleSnapshot`
 * en `domain/review.ts#buildNextPreviousCounts`). Na het verwijderen van een
 * sessie wordt daarom, per artikel dat in de VERWIJDERDE sessie effectief
 * fysiek geteld werd:
 *   1. de OVERBLIJVENDE sessies (chronologisch, oudste eerst) doorzocht op
 *      de LAATSTE (dus meest recente) sessie die dit artikel ook effectief
 *      fysiek telde — die telling wordt de nieuwe baseline;
 *   2. als geen enkele overblijvende sessie dit artikel ooit fysiek telde,
 *      wordt teruggevallen op de waarde die het artikel had VOORDAT de
 *      verwijderde sessie het telde (`previousCount`-veld van de verwijderde
 *      sessie's eigen snapshotrij) — dit "ontdoet" precies de bijdrage van de
 *      verwijderde sessie, zonder een nieuwe waarde te verzinnen;
 *   3. artikelen die de verwijderde sessie zelf nooit fysiek telde (die daar
 *      OVERGENOMEN/"OVERGENOMEN - NIET GETELD" stonden) blijven volledig
 *      buiten beschouwing — hun baseline werd nooit door deze sessie bepaald,
 *      dus verwijdering van deze sessie kan ze ook nooit veranderen.
 *
 * Geeft enkel de artikelen terug wiens `previousCount` daadwerkelijk
 * verandert (nooit de volledige artikellijst) — de aanroeper
 * (`CountSessionService#deleteSession`) hoeft dit resultaat enkel te
 * persisteren.
 */
export function recomputePreviousCountsAfterDeletion(
  deletedSnapshot: StockSnapshot,
  remainingSnapshotsChronological: StockSnapshot[],
  articles: Article[],
): Article[] {
  const articleById = new Map(articles.map((article) => [article.id, article]));
  const updated: Article[] = [];

  for (const deletedArticleSnapshot of deletedSnapshot.articles) {
    const wasPhysicallyCountedInDeletedSession =
      deletedArticleSnapshot.status === "GETELD" || deletedArticleSnapshot.status === "0 BEVESTIGD";
    if (!wasPhysicallyCountedInDeletedSession) {
      // Deze sessie leverde nooit een echte fysieke telling voor dit
      // artikel — er is dus niets om ongedaan te maken.
      continue;
    }

    let newCount: number | null | undefined;
    for (let i = remainingSnapshotsChronological.length - 1; i >= 0; i -= 1) {
      const snapshot = remainingSnapshotsChronological[i];
      const articleSnapshot = snapshot.articles.find(
        (candidate) => candidate.articleId === deletedArticleSnapshot.articleId,
      );
      if (
        articleSnapshot &&
        (articleSnapshot.status === "GETELD" || articleSnapshot.status === "0 BEVESTIGD")
      ) {
        newCount = articleSnapshot.totalCount;
        break;
      }
    }

    if (newCount === undefined) {
      // Geen enkele overblijvende sessie telde dit artikel ooit fysiek —
      // terugvallen op de waarde van vóór de verwijderde sessie.
      newCount = deletedArticleSnapshot.previousCount;
    }

    const article = articleById.get(deletedArticleSnapshot.articleId);
    if (article && article.previousCount !== newCount) {
      updated.push({ ...article, previousCount: newCount });
    }
  }

  return updated;
}
