import { useState } from "react";
import type { ArticleReviewResult } from "../../domain/review";
import type { Location } from "../../domain/types";
import { formatCount, formatEuro, formatSignedCount, formatSignedEuro } from "../../shared/format";
import { BigButton } from "./BigButton";

interface ReviewRowProps {
  result: ArticleReviewResult;
  locations: Location[];
  /** Navigeer naar het telscherm van deze locatie, gefocust op dit artikel (spec §3, en de v0.2.1-fix hieronder). */
  onRecount: (locationId: string, articleId: string) => void;
  /**
   * Label voor `result.previousCount` (aanvulling: "vergelijken met een
   * willekeurig gekozen telling"): standaard "Vorige telling", maar wanneer
   * de gebruiker op het reviewscherm een andere afgeronde sessie als
   * vergelijkingsbasis koos, toont deze rij die tellingnaam i.p.v. de
   * standaardtekst — zodat altijd duidelijk is waarmee vergeleken wordt.
   */
  comparisonLabel?: string;
  /**
   * Data-integriteit-sprint §1: een COMPLETED (of CANCELLED) sessie is een
   * onveranderlijke, historische snapshot — "Historische telling =
   * read-only snapshot". Verbergt hier alle acties die naar het telscherm
   * zouden navigeren om iets te (her)tellen (Tellen/Hertellen/+Andere
   * locatie, en de klikbare locatiewaarden): de rij zelf blijft volledig
   * zichtbaar/leesbaar, enkel de mutatie-acties verdwijnen. Standaard
   * `false` (ongewijzigd gedrag voor een lopende sessie).
   */
  readOnly?: boolean;
}

/**
 * Eén artikelrij op het reviewscherm (spec v0.2 §2, met een blokkerende
 * UX-fix voor v0.2.1): vorige telling, telling per locatie, nieuwe totale
 * telling, verschil, kostprijs, verschil in euro, opmerking.
 *
 * FIX (v0.2.1-hotfix): voordien kreeg een artikel enkel een knop wanneer er
 * al een CountEntry op een locatie bestond ("Hertellen"). Een volledig
 * ongeteld artikel (nog geen enkele entry, dus ook geen enkele locatie met
 * `hasEntry`) had daardoor GEEN manier om vanuit Review geteld te worden —
 * een blokkerende regressie, want Review moet elke ontbrekende telling
 * direct kunnen oplossen, niet enkel rapporteren. Nu:
 *   - "Tellen" verschijnt zodra het artikel niet volledig geteld is, en
 *     opent een locatiekeuze (ook zonder bestaande entry).
 *   - een locatiechip zonder entry ("—") is zelf ook klikbaar en telt
 *     meteen op die locatie.
 *   - is er al minstens één locatie geteld, dan komt er ook "+ Andere
 *     locatie" bij (naast "Hertellen" per al-geteld locatie).
 */
export function ReviewRow({
  result,
  locations,
  onRecount,
  comparisonLabel = "Vorige telling",
  readOnly = false,
}: ReviewRowProps) {
  const [pickingLocation, setPickingLocation] = useState(false);
  const locationById = new Map(locations.map((l) => [l.id, l]));
  const activeLocations = locations.filter((l) => l.active);
  const hasAnyCountedLocation = result.perLocation.some((loc) => loc.counted);
  const showTellenButton = !readOnly && !result.fullyCounted && !result.isManualAddition;
  const showAndereLocatieButton = !readOnly && hasAnyCountedLocation && !result.isManualAddition;

  function chooseLocation(locationId: string) {
    setPickingLocation(false);
    onRecount(locationId, result.articleId);
  }

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
          const canCountHere = !readOnly && !loc.hasEntry && (location?.active ?? false);
          return (
            <span key={loc.locationId} className="review-row__location">
              {location?.name ?? `Locatie ${loc.locationNumber}`}:{" "}
              {canCountHere ? (
                <button
                  type="button"
                  className="review-row__location-value review-row__location-value--clickable"
                  onClick={() => onRecount(loc.locationId, result.articleId)}
                >
                  {display}
                </button>
              ) : (
                <span className="review-row__location-value">{display}</span>
              )}
              {loc.hasEntry && !readOnly && (
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

      {(showTellenButton || showAndereLocatieButton) && (
        <div className="filter-row">
          {showTellenButton && (
            <button type="button" className="chip chip--active" onClick={() => setPickingLocation(true)}>
              Tellen
            </button>
          )}
          {showAndereLocatieButton && (
            <button type="button" className="chip" onClick={() => setPickingLocation(true)}>
              + Andere locatie
            </button>
          )}
        </div>
      )}

      {pickingLocation && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Kies een locatie om te tellen</p>
            <p className="screen-subtitle" style={{ margin: 0 }}>
              {result.article.description} ({result.article.articleNumber})
            </p>
            <div className="stack stack--tight">
              {activeLocations.map((location) => (
                <BigButton key={location.id} variant="secondary" onClick={() => chooseLocation(location.id)}>
                  {location.name}
                </BigButton>
              ))}
            </div>
            <BigButton variant="ghost" onClick={() => setPickingLocation(false)}>
              Annuleren
            </BigButton>
          </div>
        </div>
      )}

      <div className="review-row__figures">
        <div>
          <div className="review-row__figure-label">{comparisonLabel}</div>
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
