import type { ArticleReviewResult } from "../../domain/review";
import type { Location } from "../../domain/types";
import { formatCount, formatEuro, formatSignedCount, formatSignedEuro } from "../../shared/format";

interface ReviewRowProps {
  result: ArticleReviewResult;
  locations: Location[];
  /** Navigeer terug naar het telscherm van deze locatie, gefocust op dit artikel (spec §3). */
  onRecount: (locationId: string, articleId: string) => void;
}

/**
 * Eén artikelrij op het reviewscherm (spec v0.2 §2): vorige telling, telling
 * per locatie, nieuwe totale telling, verschil, kostprijs, verschil in euro,
 * opmerking — plus "Hertellen"-links per locatie die al een entry heeft.
 */
export function ReviewRow({ result, locations, onRecount }: ReviewRowProps) {
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const rowClass = [
    "review-row",
    !result.fullyCounted && !result.isManualAddition ? "review-row--not-counted" : "",
    result.fullyCounted && result.differenceQuantity ? "review-row--difference" : "",
    result.flaggedForControl ? "review-row--control" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClass}>
      <div className="review-row__header">
        <span className="review-row__description">
          {result.article.description || "(geen omschrijving)"}
        </span>
        <div className="review-row__badges">
          {result.isManualAddition && (
            <span className="review-row__badge review-row__badge--manual">Buiten scope</span>
          )}
          {!result.fullyCounted && (
            <span className="review-row__badge review-row__badge--not-counted">Niet geteld</span>
          )}
          {result.flaggedForControl && (
            <span className="review-row__badge review-row__badge--control">Controle</span>
          )}
        </div>
      </div>
      <div className="review-row__meta">
        {result.article.articleNumber}
        {result.article.productGroup ? ` · ${result.article.productGroup}` : ""}
      </div>

      <div className="review-row__locations">
        {result.perLocation.map((loc) => {
          const location = locationById.get(loc.locationId);
          const display = loc.counted ? formatCount(loc.quantity) : loc.hasEntry ? "nog te tellen" : "—";
          return (
            <span key={loc.locationId} className="review-row__location">
              {location?.name ?? `Locatie ${loc.locationNumber}`}:{" "}
              <span className="review-row__location-value">{display}</span>
              {loc.hasEntry && (
                <button
                  type="button"
                  className="review-row__recount"
                  onClick={() => onRecount(loc.locationId, result.articleId)}
                >
                  Hertellen
                </button>
              )}
            </span>
          );
        })}
      </div>

      <div className="review-row__figures">
        <div>
          <div className="review-row__figure-label">Vorige telling</div>
          <div className="review-row__figure-value">{formatCount(result.previousCount)}</div>
        </div>
        <div>
          <div className="review-row__figure-label">Nieuwe telling</div>
          <div className="review-row__figure-value">{formatCount(result.newTotalCount)}</div>
        </div>
        <div>
          <div className="review-row__figure-label">Verschil aantal</div>
          <div
            className={[
              "review-row__figure-value",
              result.differenceQuantity && result.differenceQuantity > 0
                ? "review-row__figure-value--positive"
                : "",
              result.differenceQuantity && result.differenceQuantity < 0
                ? "review-row__figure-value--negative"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {formatSignedCount(result.differenceQuantity)}
          </div>
        </div>
        <div>
          <div className="review-row__figure-label">Kostprijs</div>
          <div className="review-row__figure-value">{formatEuro(result.costPrice)}</div>
        </div>
        <div>
          <div className="review-row__figure-label">Verschil bedrag</div>
          <div
            className={[
              "review-row__figure-value",
              result.differenceAmount && result.differenceAmount > 0
                ? "review-row__figure-value--positive"
                : "",
              result.differenceAmount && result.differenceAmount < 0
                ? "review-row__figure-value--negative"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {formatSignedEuro(result.differenceAmount)}
          </div>
        </div>
      </div>

      {result.note && <div className="review-row__note">{result.note}</div>}
    </div>
  );
}
