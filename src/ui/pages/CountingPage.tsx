import { useEffect, useMemo, useRef, useState } from "react";
import type { Article } from "../../domain/types";
import { sortArticlesForLocation } from "../../domain/sorting";
import { requiresOutOfScopeConfirmation } from "../../domain/sessionScope";
import { countingService } from "../../application/container";
import { ArticleCard } from "../components/ArticleCard";
import { BigButton } from "../components/BigButton";
import { FilterBar, type CountFilter } from "../components/FilterBar";
import { SESSION_TYPE_NOUN_LOWER } from "../sessionTypeLabels";
import {
  useArticles,
  useAssignments,
  useCountEntries,
  useOffice,
  useSession,
} from "../hooks/useLiveData";

interface CountingPageProps {
  sessionId: string;
  locationId: string;
  /**
   * Artikel om bij het openen naar toe te scrollen — gebruikt door de
   * "Hertellen"-navigatie vanuit het reviewscherm (spec v0.2 §3: "gebruiker
   * moet vanuit review terug naar het artikel kunnen om te hertellen").
   * Beïnvloedt geen filters: het artikel heeft per definitie al een entry op
   * deze locatie, en zit dus altijd in de standaardweergave.
   */
  focusArticleId?: string;
}

export function CountingPage({ sessionId, locationId, focusArticleId }: CountingPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const officeArticles = useArticles(session?.officeId) ?? [];
  const entries = useCountEntries(sessionId) ?? [];
  const assignments = useAssignments(session?.officeId) ?? [];

  const [filter, setFilter] = useState<CountFilter>("ALL");
  const [productGroup, setProductGroup] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showOtherSearch, setShowOtherSearch] = useState(false);
  const [draftQuantities, setDraftQuantities] = useState<Record<string, number | null>>({});
  const [outOfScopeConfirm, setOutOfScopeConfirm] = useState<{ article: Article; index: number } | null>(
    null,
  );

  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const location = office?.locations.find((l) => l.id === locationId);

  const entriesAtLocation = useMemo(
    () => entries.filter((e) => e.locationId === locationId),
    [entries, locationId],
  );
  const entryByArticleId = useMemo(() => {
    const map = new Map<string, (typeof entriesAtLocation)[number]>();
    for (const entry of entriesAtLocation) map.set(entry.articleId, entry);
    return map;
  }, [entriesAtLocation]);

  const expectedArticleIds = useMemo(() => {
    return new Set(
      assignments
        .filter((a) => a.active && a.locationId === locationId)
        .map((a) => a.articleId),
    );
  }, [assignments, locationId]);

  const articleById = useMemo(() => {
    const map = new Map<string, Article>();
    for (const article of officeArticles) map.set(article.id, article);
    return map;
  }, [officeArticles]);

  const scopeArticles = useMemo(() => {
    if (!session) return [];
    return session.articleIds.map((id) => articleById.get(id)).filter((a): a is Article => !!a);
  }, [session, articleById]);

  const knownAtLocation = useMemo(
    () =>
      scopeArticles.filter(
        (article) => expectedArticleIds.has(article.id) || entryByArticleId.has(article.id),
      ),
    [scopeArticles, expectedArticleIds, entryByArticleId],
  );

  const isLearningMode = knownAtLocation.length === 0;
  const defaultPool = isLearningMode ? scopeArticles : knownAtLocation;
  const pool = showOtherSearch ? officeArticles : defaultPool;

  const productGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const article of pool) {
      if (article.productGroup) groups.add(article.productGroup);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b, "nl"));
  }, [pool]);

  const filtered = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return pool.filter((article) => {
      const counted = entryByArticleId.get(article.id)?.counted ?? false;
      if (filter === "TODO" && counted) return false;
      if (filter === "DONE" && !counted) return false;
      if (productGroup && article.productGroup !== productGroup) return false;
      if (searchLower) {
        const haystack = `${article.articleNumber} ${article.description}`.toLowerCase();
        if (!haystack.includes(searchLower)) return false;
      }
      return true;
    });
  }, [pool, entryByArticleId, filter, productGroup, search]);

  const sorted = useMemo(
    () => sortArticlesForLocation(filtered, expectedArticleIds),
    [filtered, expectedArticleIds],
  );

  useEffect(() => {
    if (!focusArticleId) return;
    if (!sorted.some((a) => a.id === focusArticleId)) return;
    requestAnimationFrame(() => {
      cardRefs.current.get(focusArticleId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // Enkel bij het openen van dit scherm scrollen, niet bij elke herrender
    // (bv. na het intikken van een aantal) — bewust enkel op focusArticleId.
  }, [focusArticleId]);

  if (!session || !office || !location) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  function getQuantity(article: Article): number | null {
    if (article.id in draftQuantities) return draftQuantities[article.id];
    return entryByArticleId.get(article.id)?.quantity ?? null;
  }

  async function performRecord(article: Article, index: number, isManualAddition: boolean) {
    const quantity = getQuantity(article);
    if (quantity === null || !session) return;
    await countingService.recordCount({
      session,
      articleId: article.id,
      locationId,
      quantity,
      note: isManualAddition
        ? `Buiten sessiescope: handmatig toegevoegd tijdens ${SESSION_TYPE_NOUN_LOWER[session.type]}.`
        : undefined,
    });
    setDraftQuantities((prev) => {
      const next = { ...prev };
      delete next[article.id];
      return next;
    });

    const next = sorted
      .slice(index + 1)
      .find((a) => !(entryByArticleId.get(a.id)?.counted ?? false));
    if (next) {
      requestAnimationFrame(() => {
        cardRefs.current.get(next.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  function confirm(article: Article, index: number) {
    if (!session) return;
    const alreadyHasEntry = entryByArticleId.has(article.id);
    if (requiresOutOfScopeConfirmation(session, article.id, alreadyHasEntry)) {
      setOutOfScopeConfirm({ article, index });
      return;
    }
    void performRecord(article, index, false);
  }

  return (
    <div className="stack">
      <h1 className="screen-title">
        {office.name} &gt; {location.name}
      </h1>

      {isLearningMode && !showOtherSearch && (
        <div className="warning-banner">
          Nog geen vaste artikelindeling voor deze locatie. Zoek en tel een artikel — de volgende
          keer verschijnt het automatisch hier.
        </div>
      )}

      <input
        className="search-input"
        placeholder="Zoek op artikelnummer of omschrijving..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <FilterBar
        filter={filter}
        onFilterChange={setFilter}
        productGroups={productGroups}
        selectedProductGroup={productGroup}
        onProductGroupChange={setProductGroup}
      />

      {!isLearningMode && !showOtherSearch && (
        <button className="big-button big-button--ghost" onClick={() => setShowOtherSearch(true)}>
          + Ander artikel tellen
        </button>
      )}
      {showOtherSearch && (
        <button className="big-button big-button--ghost" onClick={() => setShowOtherSearch(false)}>
          Terug naar verwachte artikelen
        </button>
      )}

      <div className="stack">
        {sorted.length === 0 && <p className="empty-state">Geen artikelen gevonden.</p>}
        {sorted.map((article, index) => {
          const entry = entryByArticleId.get(article.id);
          const counted = entry?.counted ?? false;
          const hasNextTodo = sorted
            .slice(index + 1)
            .some((a) => !(entryByArticleId.get(a.id)?.counted ?? false));
          return (
            <ArticleCard
              key={article.id}
              ref={(node) => {
                if (node) cardRefs.current.set(article.id, node);
                else cardRefs.current.delete(article.id);
              }}
              article={article}
              counted={counted}
              quantity={getQuantity(article)}
              onQuantityChange={(value) =>
                setDraftQuantities((prev) => ({ ...prev, [article.id]: value }))
              }
              onConfirm={() => confirm(article, index)}
              confirmLabel={hasNextTodo ? "Geteld & volgende" : "Geteld"}
            />
          );
        })}
      </div>

      {outOfScopeConfirm && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>
              Dit artikel behoort normaal niet tot deze {SESSION_TYPE_NOUN_LOWER[session.type]}.
            </p>
            <p className="screen-subtitle" style={{ margin: 0 }}>
              {outOfScopeConfirm.article.description} ({outOfScopeConfirm.article.articleNumber})
            </p>
            <div className="stack">
              <BigButton
                variant="primary"
                onClick={() => {
                  const { article, index } = outOfScopeConfirm;
                  setOutOfScopeConfirm(null);
                  void performRecord(article, index, true);
                }}
              >
                Toch tellen
              </BigButton>
              <BigButton variant="ghost" onClick={() => setOutOfScopeConfirm(null)}>
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
