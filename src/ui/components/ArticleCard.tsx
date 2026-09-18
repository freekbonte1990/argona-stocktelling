import { forwardRef } from "react";
import type { Article } from "../../domain/types";
import { QuantityStepper } from "./QuantityStepper";

interface ArticleCardProps {
  article: Article;
  counted: boolean;
  quantity: number | null;
  onQuantityChange: (value: number | null) => void;
  onConfirm: () => void;
  confirmLabel: string;
}

/**
 * Kaart voor één artikel op het telscherm.
 * Omschrijving staat prominent bovenaan, artikelnummer is secundair.
 */
export const ArticleCard = forwardRef<HTMLDivElement, ArticleCardProps>(function ArticleCard(
  { article, counted, quantity, onQuantityChange, onConfirm, confirmLabel },
  ref,
) {
  return (
    <div ref={ref} className={`article-card ${counted ? "article-card--counted" : ""}`}>
      <div className="article-card__description">{article.description || "(geen omschrijving)"}</div>
      <div className="article-card__meta">
        <span>{article.articleNumber}</span>
        {article.productGroup && <span>{article.productGroup}</span>}
        <span>Vorige telling: {article.previousCount ?? "—"}</span>
        {article.unit && <span>Eenheid: {article.unit}</span>}
      </div>
      <QuantityStepper value={quantity} onChange={onQuantityChange} />
      <button
        type="button"
        className="big-button big-button--primary"
        onClick={onConfirm}
        disabled={quantity === null}
      >
        ✓ {confirmLabel}
      </button>
    </div>
  );
});
