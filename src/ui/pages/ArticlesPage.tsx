import { useMemo, useState } from "react";
import { useArticles } from "../hooks/useLiveData";

interface ArticlesPageProps {
  officeId: string;
}

/** Eenvoudige, alleen-lezen artikellijst. Verdere uitwerking (bewerken, nieuwe artikelen) volgt in een latere sprint. */
export function ArticlesPage({ officeId }: ArticlesPageProps) {
  const articles = useArticles(officeId) ?? [];
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return articles;
    return articles.filter((article) =>
      `${article.articleNumber} ${article.description}`.toLowerCase().includes(term),
    );
  }, [articles, search]);

  return (
    <div className="stack">
      <h1 className="screen-title">Artikels</h1>
      <p className="screen-subtitle">{articles.length} artikelen</p>
      <input
        className="search-input"
        placeholder="Zoek op artikelnummer of omschrijving..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="stack stack--tight">
        {filtered.slice(0, 200).map((article) => (
          <div key={article.id} className="article-card">
            <div className="article-card__description">{article.description}</div>
            <div className="article-card__meta">
              <span>{article.articleNumber}</span>
              {article.productGroup && <span>{article.productGroup}</span>}
              <span>Telfrequentie: {article.rawCountPeriod ?? "—"}</span>
              <span>Vorige telling: {article.previousCount ?? "—"}</span>
            </div>
          </div>
        ))}
        {filtered.length > 200 && (
          <p className="empty-state">
            {filtered.length - 200} extra resultaten niet getoond — verfijn je zoekopdracht.
          </p>
        )}
      </div>
    </div>
  );
}
