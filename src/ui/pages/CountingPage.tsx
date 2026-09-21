import { useEffect, useMemo, useRef, useState } from "react";
import type { Article } from "../../domain/types";
import { type ArticleSortMode, sortArticlesForLocation } from "../../domain/sorting";
import { requiresOutOfScopeConfirmation } from "../../domain/sessionScope";
import { countingService } from "../../application/container";
import { ArticleCard } from "../components/ArticleCard";
import { BigButton } from "../components/BigButton";
import { FilterBar, type CountFilter } from "../components/FilterBar";
import { NewArticleFoundModal } from "../components/NewArticleFoundModal";
import { SESSION_TYPE_NOUN_LOWER } from "../sessionTypeLabels";
import {
  useArticles,
  useAssignments,
  useCountEntries,
  useLocationStatuses,
  useOffice,
  useSession,
} from "../hooks/useLiveData";

interface CountingPageProps {
  sessionId: string;
  locationId: string;
  /**
   * Artikel om bij het openen naar toe te scrollen — gebruikt door de
   * "Tellen"/"Hertellen"/"+ Andere locatie"-navigatie vanuit het
   * reviewscherm (spec v0.2 §3, en de v0.2.1-hotfix: "Tellen moet ook werken
   * wanneer er nog GEEN CountEntry bestaat"). Heeft het artikel hier nog
   * geen entry of verwachting, dan schakelt de pagina automatisch naar "alle
   * artikelen" zodat het toch zichtbaar en telbaar is — zie de effects
   * hieronder.
   */
  focusArticleId?: string;
}

export function CountingPage({ sessionId, locationId, focusArticleId }: CountingPageProps) {
  const session = useSession(sessionId);
  const office = useOffice(session?.officeId);
  const officeArticles = useArticles(session?.officeId) ?? [];
  const entries = useCountEntries(sessionId) ?? [];
  const assignments = useAssignments(session?.officeId) ?? [];
  const locationStatuses = useLocationStatuses(sessionId) ?? [];

  const [filter, setFilter] = useState<CountFilter>("ALL");
  const [productGroup, setProductGroup] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<ArticleSortMode>("GROUP_THEN_DESCRIPTION");
  const [search, setSearch] = useState("");
  const [showOtherSearch, setShowOtherSearch] = useState(false);
  const [draftQuantities, setDraftQuantities] = useState<Record<string, number | null>>({});
  const [outOfScopeConfirm, setOutOfScopeConfirm] = useState<{ article: Article; index: number } | null>(
    null,
  );
  const [unexpectedLocationConfirm, setUnexpectedLocationConfirm] = useState<{
    article: Article;
    index: number;
    otherLocationName: string;
  } | null>(null);
  const [locationActionError, setLocationActionError] = useState<string | null>(null);
  const [newArticleFoundOpen, setNewArticleFoundOpen] = useState(false);

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

  /**
   * Alle entries van dit artikel binnen deze sessie, ONGEACHT locatie — nodig
   * voor het filter "Nog nergens geteld" (spec §2), dat over de hele sessie
   * gaat, niet enkel deze locatie (anders zou een artikel dat al op een
   * ándere locatie geteld is hier verkeerdelijk als "nog te doen" verschijnen).
   */
  const hasAnyEntryAnywhere = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) ids.add(entry.articleId);
    return ids;
  }, [entries]);

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
      const countedHere = entryByArticleId.get(article.id)?.counted ?? false;
      if (filter === "COUNTED_HERE" && !countedHere) return false;
      if (filter === "NOT_COUNTED_ANYWHERE" && hasAnyEntryAnywhere.has(article.id)) return false;
      if (productGroup && article.productGroup !== productGroup) return false;
      if (searchLower) {
        const haystack = `${article.articleNumber} ${article.description}`.toLowerCase();
        if (!haystack.includes(searchLower)) return false;
      }
      return true;
    });
  }, [pool, entryByArticleId, hasAnyEntryAnywhere, filter, productGroup, search]);

  const sorted = useMemo(
    () => sortArticlesForLocation(filtered, expectedArticleIds, sortMode),
    [filtered, expectedArticleIds, sortMode],
  );

  const locationStatus = locationStatuses.find((s) => s.locationId === locationId)?.status ?? "OPEN";

  /**
   * FIX (v0.2.1-hotfix, blokkerende regressie): vanuit Review kan je nu ook
   * "Tellen" op een artikel dat op DEZE locatie nog geen enkele entry of
   * verwachting heeft (spec: "Tellen moet ook werken wanneer er nog GEEN
   * CountEntry bestaat"). Zonder ingreep valt zo'n artikel buiten
   * `defaultPool` (niet verwacht, geen entry) en verschijnt het dus
   * nergens — precies de bug. Bij het openen met een `focusArticleId` dat
   * niet in de standaardweergave zit, schakelen we daarom automatisch naar
   * "alle artikelen" (zoals "+ Bestaand artikel opzoeken") en zetten we de
   * filters neutraal, zodat het artikel gegarandeerd zichtbaar is. Dit
   * gebeurt maar één keer per focusArticleId (via de ref), niet bij elke
   * doorlopende herrender.
   */
  const handledFocusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusArticleId || !session) return;
    if (handledFocusRef.current === focusArticleId) return;
    handledFocusRef.current = focusArticleId;
    const inDefaultPool = defaultPool.some((a) => a.id === focusArticleId);
    if (!inDefaultPool) {
      setShowOtherSearch(true);
    }
    setFilter("ALL");
    setProductGroup(null);
    setSearch("");
  }, [focusArticleId, session, defaultPool]);

  const scrolledFocusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusArticleId) return;
    if (scrolledFocusRef.current === focusArticleId) return;
    if (!sorted.some((a) => a.id === focusArticleId)) return;
    scrolledFocusRef.current = focusArticleId;
    requestAnimationFrame(() => {
      cardRefs.current.get(focusArticleId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // Loopt door totdat het artikel effectief in `sorted` zit (bv. nadat de
    // pool-aanpassing hierboven is toegepast) — daarna nooit meer, per
    // focusArticleId, dankzij de ref-guard.
  }, [focusArticleId, sorted]);

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

  function proceedAfterLocationCheck(article: Article, index: number) {
    if (!session) return;
    const alreadyHasEntry = entryByArticleId.has(article.id);
    if (requiresOutOfScopeConfirmation(session, article.id, alreadyHasEntry)) {
      setOutOfScopeConfirm({ article, index });
      return;
    }
    void performRecord(article, index, false);
  }

  /**
   * Spec v0.2.1 §6: "bij tellen op onverwachte locatie" (het artikel wordt
   * al ergens ANDERS actief verwacht, maar niet hier) moet er eerst
   * bevestigd worden vóór het geteld wordt — nooit stilletjes wijzigen.
   *
   * AANNAME (gedocumenteerd): "bevestigen" betekent hier "toevoegen als
   * extra locatie" (spec §3 blijft de norm: één artikel mag op meerdere
   * locaties liggen, beide koppelingen blijven behouden) — niet "de vaste
   * locatie vervangen". Er is bewust geen apart "vervangen"-pad gebouwd: dat
   * zou een aparte, expliciete actie zijn die de spec niet vraagt, en botst
   * met "geen ingewikkelde wizard" (§6 slot).
   */
  function confirm(article: Article, index: number) {
    if (!session) return;
    const alreadyHasEntry = entryByArticleId.has(article.id);
    const activeAssignmentsForArticle = assignments.filter((a) => a.active && a.articleId === article.id);
    const isExpectedHere = activeAssignmentsForArticle.some((a) => a.locationId === locationId);
    const otherAssignment = activeAssignmentsForArticle.find((a) => a.locationId !== locationId);

    if (!isExpectedHere && !alreadyHasEntry && otherAssignment) {
      const otherLocationName =
        office?.locations.find((l) => l.id === otherAssignment.locationId)?.name ?? "een andere locatie";
      setUnexpectedLocationConfirm({ article, index, otherLocationName });
      return;
    }

    proceedAfterLocationCheck(article, index);
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
        sortMode={sortMode}
        onSortModeChange={setSortMode}
      />

      {/*
       * UX-fix (v0.2.1 correctieronde, kleine naam/visuele correctie):
       * "Bestaand artikel opzoeken" is een secundaire, subtielere actie
       * (kantoorbreed zoeken naar een bestaand artikel dat hier niet
       * verwacht werd) — de gewone zoekbalk hierboven blijft de normale weg
       * binnen de huidige weergave. "Nieuw artikel gevonden" (een artikel
       * dat nog niet in de artikelstam staat) blijft bewust een duidelijk
       * zichtbare, eigen actie — vandaar het visuele verschil (tekstlink vs.
       * volwaardige knop). Businesslogica/sessiescope-bevestigingen zijn
       * hierdoor niet gewijzigd.
       */}
      {!isLearningMode && !showOtherSearch && (
        <button className="text-link-button" onClick={() => setShowOtherSearch(true)}>
          + Bestaand artikel opzoeken
        </button>
      )}
      {showOtherSearch && (
        <button className="text-link-button" onClick={() => setShowOtherSearch(false)}>
          Terug naar verwachte artikelen
        </button>
      )}
      <button className="big-button big-button--secondary" onClick={() => setNewArticleFoundOpen(true)}>
        + Nieuw artikel gevonden
      </button>

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

      {locationStatus === "COMPLETED" && (
        <div className="warning-banner">
          Deze locatie is afgerond. Je kan hier nog steeds tellen — heropen de locatie als je verder
          wil tellen.
        </div>
      )}
      {locationActionError && <div className="error-banner">{locationActionError}</div>}
      <BigButton
        variant={locationStatus === "COMPLETED" ? "secondary" : "primary"}
        onClick={async () => {
          setLocationActionError(null);
          try {
            if (locationStatus === "COMPLETED") {
              await countingService.reopenLocation(sessionId, locationId);
            } else {
              await countingService.completeLocation(sessionId, locationId);
            }
          } catch (err) {
            setLocationActionError(err instanceof Error ? err.message : "Onbekende fout.");
          }
        }}
      >
        {locationStatus === "COMPLETED" ? "Locatie heropenen" : "✓ Locatie afgerond"}
      </BigButton>

      {unexpectedLocationConfirm && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>
              Dit artikel werd normaal op {unexpectedLocationConfirm.otherLocationName} verwacht, maar
              wordt nu op {location.name} geteld.
            </p>
            <p className="screen-subtitle" style={{ margin: 0 }}>
              {unexpectedLocationConfirm.article.description} ({unexpectedLocationConfirm.article.articleNumber})
              — {location.name} toevoegen als extra vaste locatie voor dit artikel?
            </p>
            <div className="stack">
              <BigButton
                variant="primary"
                onClick={() => {
                  const { article, index } = unexpectedLocationConfirm;
                  setUnexpectedLocationConfirm(null);
                  proceedAfterLocationCheck(article, index);
                }}
              >
                Ja, toevoegen
              </BigButton>
              <BigButton variant="ghost" onClick={() => setUnexpectedLocationConfirm(null)}>
                Annuleren
              </BigButton>
            </div>
          </div>
        </div>
      )}

      {newArticleFoundOpen && (
        <NewArticleFoundModal
          session={session}
          locationId={locationId}
          locationName={location.name}
          onClose={() => setNewArticleFoundOpen(false)}
          onCreated={() => setNewArticleFoundOpen(false)}
        />
      )}

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
