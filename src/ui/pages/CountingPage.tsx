import { useEffect, useMemo, useRef, useState } from "react";
import type { Article } from "../../domain/types";
import { ARTICLE_SORT_MODE_LABELS, type ArticleSortMode, sortArticlesForLocation } from "../../domain/sorting";
import { requiresOutOfScopeConfirmation } from "../../domain/sessionScope";
import { isExtremeDeviation } from "../../domain/deviationWarning";
import {
  COUNT_FILTER_LABELS,
  defaultCountFilter,
  findNextTodoItem,
  matchesCountFilter,
  type CountFilter,
} from "../../domain/countView";
import { countingService } from "../../application/container";
import { ArticleCard } from "../components/ArticleCard";
import { BigButton } from "../components/BigButton";
import { NewArticleFoundModal } from "../components/NewArticleFoundModal";
import { SESSION_TYPE_NOUN_LOWER } from "../sessionTypeLabels";
import { formatCount, formatSignedCount, formatSignedEuro } from "../../shared/format";
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

  /**
   * v0.3 §3: standaard "Nog te tellen" bij een normale telling, maar
   * "Alles" (de bestaande brede browse-flow) tijdens leermodus — zie
   * `defaultCountFilter`. `null` betekent "gebruiker heeft nog niet zelf een
   * tab gekozen": de default wordt dan live herberekend uit `isLearningMode`
   * (hieronder), zodat een leermodus die tijdens het laden overgaat in een
   * normale telling automatisch de juiste default toont — zodra de
   * gebruiker zelf een tab aantikt, wint die keuze voorgoed.
   */
  const [filterOverride, setFilterOverride] = useState<CountFilter | null>(null);
  const [productGroup, setProductGroup] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<ArticleSortMode>("GROUP_THEN_DESCRIPTION");
  const [search, setSearch] = useState("");
  /**
   * Mobile/tablet UX-fix: productgroepen en het "Nog nergens geteld"-filter
   * staan niet langer permanent open, maar achter deze compacte
   * "Filters (N)"-knop (zelfde patroon als ArticlesPage) — puur presentatie,
   * `filter`/`productGroup` en hun betekenis (`matchesCountFilter` in
   * domain/countView.ts) blijven volledig ongewijzigd.
   */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showOtherSearch, setShowOtherSearch] = useState(false);
  /**
   * BUGFIX "Bestaand artikel opzoeken": apart van `showOtherSearch` zelf,
   * omdat die state OOK automatisch aangezet wordt door het
   * `focusArticleId`-effect hieronder (v0.2.1-hotfix: "Tellen" vanuit
   * Review op een artikel zonder bestaande verwachting/entry hier) — dat
   * bestaande pad moet, zoals voorheen, gewoon ALLES tonen (inclusief al
   * gekende artikelen), puur om het gefocuste artikel gegarandeerd
   * zichtbaar te maken. Enkel de EXPLICIETE, door de gebruiker zelf
   * aangeklikte "+ Bestaand artikel opzoeken"-knop is de echte office-wide
   * zoekmodus uit deze bugfix, en sluit al-gekende (normaal al zichtbare)
   * artikelen uit.
   */
  const [manualLookup, setManualLookup] = useState(false);
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
  /**
   * v0.4 data-integriteit-sprint §7: "Grote afwijking" — een zachte
   * waarschuwing, geen harde blokkering. `confirmedDeviations` onthoudt per
   * artikel de LAATST bevestigde extreme hoeveelheid: een hertelling met
   * exact diezelfde waarde triggert de dialoog niet opnieuw, maar een nieuwe,
   * ANDERE afwijkende waarde (of een ander artikel) wel weer.
   */
  const [confirmedDeviations, setConfirmedDeviations] = useState<Record<string, number>>({});
  const [deviationConfirm, setDeviationConfirm] = useState<{
    article: Article;
    index: number;
    isManualAddition: boolean;
    quantity: number;
  } | null>(null);

  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  /** v0.3 §1: hoeveelheidvelden per artikel, om een "actieve" kaart programmatisch te kunnen focussen. */
  const quantityInputRefs = useRef(new Map<string, HTMLInputElement>());

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

  /**
   * BUGFIX (functionele regressie "Bestaand artikel opzoeken toont nog
   * steeds enkel de verwachte locatie-artikelen"): de eigenlijke
   * poolwissel (`officeArticles` i.p.v. `defaultPool`) klopte al, maar
   * `sortArticlesForLocation` zet artikelen die HIER verwacht worden altijd
   * eerst — bij een kantoor met veel artikelen bleven die dus bovenaan
   * staan en leek de (ongewijzigde) lijst zichtbaar identiek, ook al stond
   * het net gevonden artikel verderop al wél tussen de resultaten.
   * Spec-fix: artikelen die al "gekoppeld" zijn aan deze locatie (exact
   * `knownAtLocation`: verwacht hier, of hier al een entry) horen sowieso
   * niet als zoekresultaat terug te komen — die zijn al gewoon zichtbaar in
   * de normale modus. Dat maakt de office-wide zoekmodus ook meteen
   * ondubbelzinnig ander dan de normale weergave.
   */
  const knownAtLocationIds = useMemo(
    () => new Set(knownAtLocation.map((article) => article.id)),
    [knownAtLocation],
  );
  const pool = showOtherSearch
    ? manualLookup
      ? officeArticles.filter((article) => !knownAtLocationIds.has(article.id))
      : officeArticles
    : defaultPool;

  /**
   * Enkel gevuld tijdens de EXPLICIETE "Bestaand artikel opzoeken"-modus:
   * per artikel de namen van de locatie(s) waar het al een actieve vaste
   * koppeling heeft (spec: "toon ... eventueel bestaande locatie(s)"). Puur
   * presentatie/leesvoer op basis van de al beschikbare `assignments`-data —
   * geen nieuwe businesslogica of extra repository-aanroepen.
   */
  const existingLocationNamesByArticleId = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!manualLookup || !office) return map;
    for (const assignment of assignments) {
      if (!assignment.active) continue;
      const locationName = office.locations.find((l) => l.id === assignment.locationId)?.name;
      if (!locationName) continue;
      const names = map.get(assignment.articleId);
      if (names) names.push(locationName);
      else map.set(assignment.articleId, [locationName]);
    }
    return map;
  }, [manualLookup, office, assignments]);

  const filter: CountFilter = filterOverride ?? defaultCountFilter(isLearningMode);

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
      const hasAnyEntry = hasAnyEntryAnywhere.has(article.id);
      if (!matchesCountFilter(filter, countedHere, hasAnyEntry)) return false;
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
    setFilterOverride("ALL");
    setProductGroup(null);
    setSearch("");
  }, [focusArticleId, session, defaultPool]);

  /**
   * v0.3 §1: scrollt EN focust (met geselecteerde tekst, klaar om te
   * overtikken) het hoeveelheidveld van een artikel — de centrale helper
   * achter "een artikelkaart wordt actief" (initieel laden, na opslaan naar
   * het volgende, vanuit Review, of bij een eenduidig zoekresultaat).
   */
  function activateArticle(articleId: string) {
    requestAnimationFrame(() => {
      cardRefs.current.get(articleId)?.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = quantityInputRefs.current.get(articleId);
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  const scrolledFocusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusArticleId) return;
    if (scrolledFocusRef.current === focusArticleId) return;
    if (!sorted.some((a) => a.id === focusArticleId)) return;
    scrolledFocusRef.current = focusArticleId;
    activateArticle(focusArticleId);
    // Loopt door totdat het artikel effectief in `sorted` zit (bv. nadat de
    // pool-aanpassing hierboven is toegepast) — daarna nooit meer, per
    // focusArticleId, dankzij de ref-guard.
  }, [focusArticleId, sorted]);

  /**
   * v0.3 §1: bij het openen van een locatie (zonder expliciete
   * focusArticleId vanuit Review, dat geval regelen de effects hierboven)
   * krijgt het eerste nog te tellen artikel in de huidige weergave meteen
   * focus — de gebruiker kan direct typen. Draait maar één keer per bezoek
   * aan dit scherm (ref-guard): latere filter-/zoekwijzigingen van de
   * gebruiker mogen nooit ongevraagd de focus wegkapen.
   */
  const initialFocusRef = useRef(false);
  useEffect(() => {
    if (initialFocusRef.current) return;
    if (focusArticleId) return;
    if (!session) return;
    if (sorted.length === 0) return; // wacht tot de (live-query-)data geladen is.
    initialFocusRef.current = true;
    const first = sorted.find((a) => !(entryByArticleId.get(a.id)?.counted ?? false)) ?? sorted[0];
    activateArticle(first.id);
  }, [focusArticleId, session, sorted, entryByArticleId]);

  if (!session || !office || !location) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  /**
   * Aanvulling ("niet 0 als standaardwaarde, maar het vorige getelde
   * getal — zo kan je gemakkelijk +/- klikken zonder telkens te moeten
   * typen"): een CountEntry die nog niet geteld is, heeft altijd
   * `quantity: null` (zie `CountSessionService#buildInitialEntries`) — een
   * ECHTE telling (counted:true, ook via CountingService) heeft altijd een
   * concreet getal, nooit null. De `?? null`-terugval hieronder wordt dus
   * uitsluitend gebruikt zolang er nog niet geteld is, en toont dan
   * `article.previousCount` als startpunt i.p.v. een leeg veld — bestaat er
   * geen vorige telling (nieuw artikel), dan blijft het veld leeg zoals
   * voorheen, want dan is er geen zinvol startpunt.
   */
  function getQuantity(article: Article): number | null {
    if (article.id in draftQuantities) return draftQuantities[article.id];
    return entryByArticleId.get(article.id)?.quantity ?? article.previousCount ?? null;
  }

  /**
   * v0.4 data-integriteit-sprint §7: laatste gate vóór elke effectieve
   * telling — ongeacht via welk pad (rechtstreeks, na de
   * out-of-scope-bevestiging, of na de onverwachte-locatie-bevestiging, die
   * alle drie uiteindelijk hier samenkomen). Enkel een NIEUWE (nog niet voor
   * dit artikel bevestigde) extreme afwijking onderbreekt de flow; een reeds
   * bevestigde waarde (bv. bij het per ongeluk opnieuw indienen van dezelfde
   * telling) slaat gewoon meteen normaal op.
   */
  async function performRecord(article: Article, index: number, isManualAddition: boolean) {
    const quantity = getQuantity(article);
    if (quantity === null || !session) return;

    const isExtreme = isExtremeDeviation({
      previousCount: article.previousCount,
      newQuantity: quantity,
      costPrice: article.costPrice,
    });
    if (isExtreme && confirmedDeviations[article.id] !== quantity) {
      setDeviationConfirm({ article, index, isManualAddition, quantity });
      return;
    }

    await commitRecord(article, index, isManualAddition, quantity);
  }

  async function commitRecord(
    article: Article,
    index: number,
    isManualAddition: boolean,
    quantity: number,
  ) {
    if (!session) return;
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

    // Aanvulling ("als alle artikels binnen een locatie zijn geteld mag je
    // die als afgerond zien"): meteen na een geslaagde telling nagaan of dit
    // de laatste openstaande telling op DEZE locatie was, en zo ja de
    // locatie automatisch afronden — geen aparte handmatige klik meer nodig
    // wanneer alles al geteld is. Bewust een VERSE lezing rechtstreeks uit de
    // repository (i.p.v. de mogelijk nog niet-bijgewerkte `entriesAtLocation`
    // uit de live-query hierboven, die na deze `await` nog de oude stand kan
    // tonen): zo blijft dit exact het juiste, niet-stale moment bepalen.
    // Enkel actie ondernemen als de locatie nu nog niet COMPLETED is —
    // anders zou een reeds afgeronde, nadien HEROPENDE locatie zichzelf
    // meteen weer sluiten zodra je "Locatie heropenen" klikt terwijl alles
    // toevallig nog steeds volledig geteld staat.
    if (locationStatus !== "COMPLETED") {
      const freshEntriesAtLocation = (await countingService.getEntries(sessionId)).filter(
        (e) => e.locationId === locationId,
      );
      if (freshEntriesAtLocation.length > 0 && freshEntriesAtLocation.every((e) => e.counted)) {
        await countingService.completeLocation(sessionId, locationId);
      }
    }

    // v0.3 §2/§5: automatisch door naar het volgende nog niet getelde
    // artikel binnen de huidige weergave/filter (bv. verdwijnt het zonet
    // getelde artikel meteen uit "Nog te tellen" — geen terugspringen naar
    // boven nodig). Is er geen volgende meer, dan toont de lege-lijstmelding
    // hieronder automatisch "Alle zichtbare artikels zijn geteld." zodra
    // `sorted` leegloopt.
    const next = findNextTodoItem(sorted, index, (a) => entryByArticleId.get(a.id)?.counted ?? false);
    if (next) {
      activateArticle(next.id);
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

  // v0.3 §4: voortgang bovenaan de locatie, gebaseerd op dezelfde
  // per-locatie-entries als LocationCard/LocationOverviewPage (consistente
  // definitie doorheen de app) — dus NIET op `pool`, die tijdens leermodus
  // de hele sessiescope kan omvatten. Live, want `entriesAtLocation` volgt
  // rechtstreeks de live-query op `entries`.
  const locationEntriesTotal = entriesAtLocation.length;
  const locationEntriesCounted = entriesAtLocation.filter((e) => e.counted).length;
  const locationEntriesRemaining = locationEntriesTotal - locationEntriesCounted;
  const locationProgressPct =
    locationEntriesTotal > 0 ? Math.round((locationEntriesCounted / locationEntriesTotal) * 100) : 0;

  /**
   * Mobile/tablet UX-fix: badge op de "Filters"-knop, zelfde patroon als
   * ArticlesPage se `activeFilterCount` — telt enkel mee wat NIET al via de
   * drie permanente tabs zichtbaar/bedienbaar is (productgroep, en het
   * "Nog nergens geteld"-filter dat nu in deze modal zit i.p.v. als vierde
   * permanente tab).
   */
  const activeFilterCount = (productGroup ? 1 : 0) + (filter === "NOT_COUNTED_ANYWHERE" ? 1 : 0);

  return (
    <div className="stack">
      <div className="stack stack--tight">
        <div>
          <div className="progress-label">
            <span>
              {locationEntriesCounted} / {locationEntriesTotal} geteld
            </span>
            <span>{locationEntriesRemaining} nog te tellen</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar__fill" style={{ width: `${locationProgressPct}%` }} />
          </div>
        </div>

        <input
          className="search-input"
          placeholder="Zoek op artikelnummer of omschrijving..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // v0.3 §6: bij exact één (logisch) zoekresultaat kan de gebruiker
            // meteen tellen — Enter springt rechtstreeks naar het hoeveelheidveld,
            // zonder de kaart eerst te moeten aantikken.
            if (sorted.length === 1) {
              e.preventDefault();
              activateArticle(sorted[0].id);
            }
          }}
        />

        {/*
         * Mobile/tablet UX-fix: enkel nog de drie primaire tabs staan
         * permanent open — exact dezelfde `filter`/`onFilterChange`-waarden
         * en `matchesCountFilter`-logica (domain/countView.ts) als voorheen,
         * puur de vierde tab ("Nog nergens geteld") verhuisde naar de
         * Filters-modal hieronder.
         */}
        <div className="filter-row">
          {(["TODO", "ALL", "DONE"] as CountFilter[]).map((key) => (
            <button
              key={key}
              className={`chip chip--primary ${filter === key ? "chip--active" : ""}`}
              onClick={() => setFilterOverride(key)}
            >
              {COUNT_FILTER_LABELS[key]}
            </button>
          ))}
        </div>

        <div className="stack stack--row counting-controls-row">
          <button
            type="button"
            className="chip counting-controls-row__filters"
            onClick={() => setFiltersOpen(true)}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <label className="counting-sort">
            <span>Sorteren:</span>
            <select
              className="search-input counting-sort__select"
              aria-label="Sorteren"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as ArticleSortMode)}
            >
              {(Object.keys(ARTICLE_SORT_MODE_LABELS) as ArticleSortMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {ARTICLE_SORT_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isLearningMode && !showOtherSearch && (
          <div className="warning-banner">
            Nog geen vaste artikelindeling voor deze locatie. Zoek en tel een artikel — de volgende
            keer verschijnt het automatisch hier.
          </div>
        )}

        {/*
         * Duidelijkheids-fix ("terug naar verwachte artikelen is niet
         * duidelijk, ik kan niet opmaken wat deze menu's betekenen"): de
         * knoppen zelf wisselden wel van label, maar er stond nergens
         * expliciet WAT er precies aan het gebeuren was terwijl je in de
         * office-wide zoekmodus zat. Deze banner maakt de actieve modus
         * ondubbelzinnig, los van de knoptekst zelf — puur presentatie,
         * `manualLookup` bestond al en wijzigt hier niets aan businesslogica.
         */}
        {manualLookup && (
          <div className="info-banner">
            Je doorzoekt nu alle artikelen van dit kantoor, ook artikelen die hier normaal niet
            verwacht worden.
          </div>
        )}

        {/*
         * UX-fix (v0.2.1 correctieronde, nu verder doorgetrokken): "Bestaand
         * artikel opzoeken" en "Nieuw artikel gevonden" zijn voortaan
         * visueel gelijkwaardige secundaire acties (beide `big-button
         * big-button--secondary`, naast elkaar) i.p.v. een klein onderlijnd
         * tekstlinkje tegenover een volwaardige knop — enkel presentatie,
         * businesslogica/sessiescope-bevestigingen zijn ongewijzigd.
         */}
        <div className="counting-secondary-actions">
          {!isLearningMode && !showOtherSearch && (
            <button
              type="button"
              className="big-button big-button--secondary"
              onClick={() => {
                // Bugfix: schakel over naar de echte office-wide zoekmodus EN
                // start met neutrale filters — een productgroep/zoekterm/tab
                // die nog uit de normale weergave stond zou anders de
                // bredere pool weer onterecht kunnen versmallen (spec: "geen
                // verwarrende gemengde toestand").
                setShowOtherSearch(true);
                setManualLookup(true);
                setSearch("");
                setProductGroup(null);
                setFilterOverride(null);
              }}
            >
              + Bestaand artikel opzoeken
            </button>
          )}
          {showOtherSearch && (
            <button
              type="button"
              className="big-button big-button--secondary"
              onClick={() => {
                setShowOtherSearch(false);
                setManualLookup(false);
                setSearch("");
                setProductGroup(null);
                setFilterOverride(null);
              }}
            >
              ← Terug naar artikelen van deze locatie
            </button>
          )}
          <button
            type="button"
            className="big-button big-button--secondary"
            onClick={() => setNewArticleFoundOpen(true)}
          >
            + Nieuw artikel gevonden
          </button>
        </div>
      </div>

      <div className="stack">
        {/*
         * v0.3 §2/§5: zodra de "Nog te tellen"-weergave leegloopt (alles
         * geteld) toont dit een duidelijke, andere melding dan een echt lege
         * zoekopdracht ("Geen artikelen gevonden.") in de andere weergaven.
         */}
        {sorted.length === 0 && (
          <p className="empty-state">
            {filter === "TODO" ? "Alle zichtbare artikelen zijn geteld." : "Geen artikelen gevonden."}
          </p>
        )}
        {sorted.map((article, index) => {
          const entry = entryByArticleId.get(article.id);
          const counted = entry?.counted ?? false;
          const hasNextTodo =
            findNextTodoItem(sorted, index, (a) => entryByArticleId.get(a.id)?.counted ?? false) !==
            undefined;
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
              existingLocationNames={existingLocationNamesByArticleId.get(article.id)}
              quantityInputRef={(el) => {
                if (el) quantityInputRefs.current.set(article.id, el);
                else quantityInputRefs.current.delete(article.id);
              }}
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

      {/*
       * Mobile/tablet UX-fix: productgroep en "Nog nergens geteld" achter
       * één compacte "Filters (N)"-knop i.p.v. permanent open — zelfde
       * `productGroup`/`onProductGroupChange` en `filter`/`setFilterOverride`
       * state als voorheen, enkel verhuisd naar deze modal. Zelfde
       * "Toepassen"-patroon als de Filters-modal op ArticlesPage.
       */}
      {filtersOpen && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Filters</p>
            <div className="stack">
              {productGroups.length > 0 && (
                <label className="filter-field">
                  <span className="filter-field__label">Productgroep</span>
                  <select
                    className="search-input"
                    value={productGroup ?? ""}
                    onChange={(e) => setProductGroup(e.target.value || null)}
                  >
                    <option value="">Alle productgroepen</option>
                    {productGroups.map((group) => (
                      <option key={group} value={group}>
                        {group}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="filter-field">
                <span className="filter-field__label">Weergave</span>
                <select
                  className="search-input"
                  value={filter === "NOT_COUNTED_ANYWHERE" ? "NOT_COUNTED_ANYWHERE" : ""}
                  onChange={(e) =>
                    setFilterOverride(
                      e.target.value === "NOT_COUNTED_ANYWHERE"
                        ? "NOT_COUNTED_ANYWHERE"
                        : defaultCountFilter(isLearningMode),
                    )
                  }
                >
                  <option value="">Standaard (tabs hierboven)</option>
                  <option value="NOT_COUNTED_ANYWHERE">
                    {COUNT_FILTER_LABELS.NOT_COUNTED_ANYWHERE}
                  </option>
                </select>
              </label>
            </div>
            <BigButton variant="primary" onClick={() => setFiltersOpen(false)}>
              Toepassen
            </BigButton>
          </div>
        </div>
      )}

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

      {/*
        Data-integriteit-sprint §7: "Grote afwijking" — zachte waarschuwing,
        geen harde blokkering. Toont expliciet Vorige telling / Nieuwe
        telling / Verschil / Waardeverschil, zodat de gebruiker in één
        oogopslag kan zien of dit een tikfout is of een oprechte, grote
        correctie.
      */}
      {deviationConfirm && (
        <div className="modal-overlay">
          <div className="modal-card stack">
            <p style={{ margin: 0, fontWeight: 700 }}>Grote afwijking</p>
            <p className="screen-subtitle" style={{ margin: 0 }}>
              {deviationConfirm.article.description} ({deviationConfirm.article.articleNumber})
            </p>
            <div className="review-row__figures">
              <div>
                <div className="review-row__figure-label">Vorige telling</div>
                <div className="review-row__figure-value">
                  {formatCount(deviationConfirm.article.previousCount)}
                </div>
              </div>
              <div>
                <div className="review-row__figure-label">Nieuwe telling</div>
                <div className="review-row__figure-value">{formatCount(deviationConfirm.quantity)}</div>
              </div>
              <div>
                <div className="review-row__figure-label">Verschil</div>
                <div className="review-row__figure-value">
                  {formatSignedCount(
                    deviationConfirm.article.previousCount !== null
                      ? deviationConfirm.quantity - deviationConfirm.article.previousCount
                      : null,
                  )}
                </div>
              </div>
              <div>
                <div className="review-row__figure-label">Waardeverschil</div>
                <div className="review-row__figure-value">
                  {formatSignedEuro(
                    deviationConfirm.article.previousCount !== null &&
                      deviationConfirm.article.costPrice !== null
                      ? (deviationConfirm.quantity - deviationConfirm.article.previousCount) *
                          deviationConfirm.article.costPrice
                      : null,
                  )}
                </div>
              </div>
            </div>
            <div className="stack">
              <BigButton
                variant="primary"
                onClick={() => {
                  const { article, index, isManualAddition, quantity } = deviationConfirm;
                  setConfirmedDeviations((prev) => ({ ...prev, [article.id]: quantity }));
                  setDeviationConfirm(null);
                  void commitRecord(article, index, isManualAddition, quantity);
                }}
              >
                Ja, bevestigen
              </BigButton>
              <BigButton variant="ghost" onClick={() => setDeviationConfirm(null)}>
                Opnieuw invoeren
              </BigButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
