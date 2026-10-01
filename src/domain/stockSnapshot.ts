import type { ArticleReviewResult, LocationCountValue, SessionReviewSummary } from "./review";
import type { Article, CountSession, CountSessionType, Location } from "./types";

/**
 * Rollend stockarchief (Excel-uitbreiding, zie docs/ARCHITECTURE.md): PURE
 * domeinlogica voor het bouwen van een volledige voorraad-snapshot bij het
 * afronden van een telling, en voor de machinevriendelijke HISTORIE-log die
 * daaruit voortvloeit.
 *
 * Bewust hier en NIET in de Excel-adapter (spec: "Hou de historieklogica
 * uit de Excel-adapter... dit moet later rechtstreeks bruikbaar zijn voor
 * eBuddy, zonder dat de domeinlogica afhankelijk is van Excel"). De
 * Excel-adapter mag dit enkel consumeren en naar cellen/rijen omzetten.
 */

/**
 * Status van één artikel binnen één voorraad-snapshot:
 *   GETELD                    -> dit artikel werd deze sessie fysiek volledig geteld.
 *   0 BEVESTIGD                -> expliciet bevestigd als niet aanwezig / voorraad 0.
 *   OVERGENOMEN                -> het artikel zat NOOIT in de scope van deze
 *                                 sessie (bv. een kwartaalartikel tijdens een
 *                                 maandtelling) — de laatst bekende geldige
 *                                 fysieke telling (Article.previousCount)
 *                                 wordt overgenomen. NOOIT automatisch 0.
 *   OVERGENOMEN - NIET GETELD  -> aanvulling ("Afronden met openstaande
 *                                 artikels"): het artikel zat WEL in de scope
 *                                 van deze sessie, maar werd bewust niet
 *                                 (volledig) fysiek geteld/opgelost — de
 *                                 sessie werd uitzonderlijk afgerond met deze
 *                                 openstaande artikelen. Semantisch anders
 *                                 dan OVERGENOMEN (dat artikel had nooit iets
 *                                 met deze sessie te maken), maar met
 *                                 dezelfde kernregel: de laatst bekende
 *                                 geldige fysieke telling wordt overgenomen,
 *                                 NOOIT automatisch 0, en dit telt NOOIT als
 *                                 een nieuwe fysieke telling (zie
 *                                 `buildArticleSnapshot`/`buildNextPreviousCounts`).
 *                                 Deze letterlijke tekenreeks is bewust ook
 *                                 meteen de zichtbare Excel-celtekst, net als
 *                                 zijn broers hierboven — geen aparte
 *                                 vertaal-/mappinglaag in de Excel-adapter.
 *   LEGACY                     -> Sprint 3.3 §3/§4 (legacy historische
 *                                 import): dit punt komt NIET uit een
 *                                 CountSession/`buildArticleSnapshot`, maar
 *                                 uit een geïmporteerd historisch
 *                                 stockbestand van vóór deze app (bron
 *                                 `LEGACY_IMPORT`, zie `StockHistoryEntry.source`).
 *                                 Bewust een EIGEN, vierde status i.p.v.
 *                                 hergebruik van GETELD: een legacy-punt kent
 *                                 geen locaties, geen sessie-volledigheid en
 *                                 geen `Article.previousCount`-bijdrage — het
 *                                 zou "normale CountSession-semantiek
 *                                 fabriceren" (spec) om dat als GETELD te
 *                                 tonen. Wordt UITSLUITEND geproduceerd door
 *                                 `domain/legacyImport.ts`, nooit door
 *                                 `buildArticleSnapshot` hieronder — een
 *                                 echte `ArticleSnapshot` (binnen een
 *                                 `StockSnapshot` van een CountSession) krijgt
 *                                 deze waarde dus nooit.
 */
export type ArticleSnapshotStatus =
  | "GETELD"
  | "0 BEVESTIGD"
  | "OVERGENOMEN"
  | "OVERGENOMEN - NIET GETELD"
  | "LEGACY";

/** Eén artikel binnen één StockSnapshot — een volledige rij van een tellingtabblad. */
export interface ArticleSnapshot {
  articleId: string;
  article: Article;
  status: ArticleSnapshotStatus;
  /** "Nieuwe telling" — de totale hoeveelheid in deze snapshot. */
  totalCount: number | null;
  /** "Vorige telling" — laatst bekende geldige fysieke telling vóór deze sessie. */
  previousCount: number | null;
  differenceQuantity: number | null;
  costPrice: number | null;
  previousValue: number | null;
  amount: number | null;
  differenceAmount: number | null;
  /** Enkel gevuld voor GETELD/0 BEVESTIGD (die een echt reviewresultaat hadden) — leeg voor OVERGENOMEN. */
  perLocation: LocationCountValue[];
  note: string | null;
}

/**
 * Eén volledige, bevroren voorraad-snapshot op het moment dat een sessie
 * wordt afgerond — spec: "een tellingtabblad moet een volledige
 * voorraad-snapshot zijn op het moment dat de sessie wordt afgerond, niet
 * enkel de artikelen die fysiek in scope waren". Bevat daarom ALTIJD alle
 * artikelen van het kantoor, niet enkel `session.articleIds`.
 */
export interface StockSnapshot {
  sessionId: string;
  sessionType: CountSessionType;
  /** Bv. "2026-09 Maand", "2026-Q3 Kwartaal", "2026 Jaar", "2026-09 Volledig". */
  sessionName: string;
  /** Lokale (niet-UTC) ISO-datum waarop de sessie werd afgerond — zie sessionSnapshotName. */
  snapshotDate: string;
  articles: ArticleSnapshot[];
  /**
   * Sprint 3.3 §1 (legacy Analyse/Vergelijken zonder fake CountSessions):
   * herkomst van deze VOLLEDIGE snapshot — `"APP_COUNT"` voor een echte,
   * afgeronde `CountSession` (via `buildSessionSnapshot` hieronder),
   * `"LEGACY_IMPORT"` voor een gesynthetiseerde snapshot van een historisch
   * geïmporteerde periode (via `buildLegacyPeriodSnapshot` hieronder). BEWUST
   * optioneel: elke bestaande snapshot/test die dit veld niet zet, betekent
   * gewoon `"APP_COUNT"` (net als `StockHistoryEntry.source`). Dit is het
   * veld dat Analysis/Comparison-UI gebruikt om een vergelijking duidelijk
   * te labelen als "Historische snapshot" — zonder ooit een legacy periode
   * als een echte `CountSession` te modelleren.
   */
  provenance?: "APP_COUNT" | "LEGACY_IMPORT";
}

/** Eén regel van de machinevriendelijke HISTORIE-tab: één artikel per telling/snapshot. */
export interface StockHistoryEntry {
  countDate: string;
  sessionType: CountSessionType;
  sessionName: string;
  articleId: string;
  articleNumber: string;
  description: string;
  totalCount: number | null;
  previousCount: number | null;
  differenceQuantity: number | null;
  costPrice: number | null;
  differenceAmount: number | null;
  status: ArticleSnapshotStatus;
  locationNames: string[];
  /**
   * Sprint 3.3 §1 (legacy Analyse/Vergelijken): de historische/bron-
   * productgroep zoals aangetroffen in het legacy-bronbestand op het moment
   * van deze snapshot (frozen fact — verandert nooit met terugwerkende
   * kracht, net als `Article.productGroup`). UITSLUITEND gezet door
   * `domain/legacyImport.ts#buildLegacyHistoryEntry`; een gewone app-sessie
   * kent dit veld niet (`undefined`) — die leest de productgroep gewoon uit
   * de (bevroren) `Article` binnen de snapshot zelf. Nodig omdat een
   * gesynthetiseerde legacy-`ArticleSnapshot` (`buildLegacyPeriodSnapshot`
   * hieronder) geen eigen bevroren `Article`-record heeft om dit uit te
   * lezen — enkel deze HISTORIE-regel bewaart het.
   */
  sourceProductGroup?: string | null;
  /**
   * Sprint 3.3 §3 (legacy historische import): herkomst van deze regel.
   * BEWUST optioneel (`?`), net als `Article.assortmentActive`: elke
   * bestaande regel (app-sessies, en elk bestand van vóór deze sprint) kent
   * dit veld nog niet — ontbrekend/`undefined` betekent altijd `"APP"` (een
   * echte CountSession), nooit een harde default die bestaande
   * objectliteralen/tests zou moeten aanpassen. `"LEGACY_IMPORT"` markeert
   * een regel die uit een geïmporteerd historisch stockbestand komt (zie
   * `domain/legacyImport.ts`) — die regels hebben altijd `status: "LEGACY"`.
   */
  source?: "APP" | "LEGACY_IMPORT";
  /**
   * Vervolg ("makkelijk vergelijken tussen toestellen" — stabiele identiteit
   * over toestellen heen): het originele `CountSession.id` van de echte
   * app-sessie die deze regel produceerde — UITSLUITEND gezet door
   * `buildHistoryEntriesFromSnapshot` hieronder (dus nooit voor een
   * `LEGACY_IMPORT`-regel, die geen echte `CountSession` heeft). Laat
   * `ImportService` een op een ANDER toestel afgeronde en herimporteerde
   * sessie herkennen aan haar ECHTE, stabiele ID — in plaats van enkel op
   * de (in theorie dubbelzinnige) combinatie sessienaam+kantoor te moeten
   * vertrouwen. BEWUST optioneel: een bestand geëxporteerd vóór deze
   * uitbreiding kent deze kolom nog niet — ontbrekend/`undefined` betekent
   * dan gewoon "onbekend, val terug op de sessienaam-heuristiek" (exact
   * hetzelfde backward-compat-idioom als `source` hierboven).
   */
  sourceSessionId?: string;
}

/**
 * Session.completedAt is een UTC ISO-timestamp (`new Date().toISOString()`,
 * zie CountSessionService). Voor de naamgeving/datum van een snapshot willen
 * we de LOKALE kalenderdag die de gebruiker zelf beleefde toen de sessie
 * werd afgerond — dezelfde aanpak als `ExcelStockResultExporter`s bestaande
 * `completedAtToLocalDate` voor de CONFIG-basisdatum. `new Date(iso)` geeft
 * het juiste moment; de LOKALE getters (`getFullYear`/`getMonth`/`getDate`)
 * geven de kalenderdag zoals de gebruiker die zag.
 */
function resolveSnapshotDate(session: Pick<CountSession, "completedAt" | "startedAt">): Date {
  const raw = session.completedAt ?? session.startedAt;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function isoDateFromLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Een periodieke telling gebeurt in de praktijk NIET op de kalendergrens
 * zelf, maar kort ERNA (de fysieke telling van Q3 vindt begin oktober
 * plaats, niet op 30 september; een maandtelling van september begin
 * oktober; een jaartelling van 2026 begin januari 2027) — zo'n telling
 * sluit de ZONET AFGESLOTEN periode af en moet dus nog diens naam dragen,
 * niet die van de nieuwe periode waar de kalenderdatum toevallig al in
 * valt. Vastgesteld (bug): een kwartaaltelling gestart/afgerond op 01/10
 * kreeg voorheen "Q4" i.p.v. het verwachte "Q3" — en dezelfde coulance is
 * ook gevraagd voor MONTHLY/YEARLY. Coulanceperiode: de eerste 14
 * kalenderdagen ná het begin van een nieuwe periode tellen nog mee als
 * afsluiting van de VORIGE periode; vanaf dag 15 is het een telling van de
 * nieuwe periode. Geldt voor MONTHLY (elke maandgrens), QUARTERLY (enkel de
 * eerste maand van een kwartaal: januari/april/juli/oktober) en YEARLY
 * (enkel januari). Bewust NIET voor FULL — dat is een ad-hoc/volledige
 * telling zonder vaste periode-cyclus, geen gevraagde wijziging daar.
 */
const PERIOD_GRACE_DAYS = 14;

/**
 * Genereert de vaste naamgevingsconventie voor tellingtabbladen, uitsluitend
 * op basis van `CountSession.type` en `completedAt` (spec), met de
 * coulanceperiode hierboven als enige uitzondering:
 *   MONTHLY   -> "2026-09 Maand"
 *   QUARTERLY -> "2026-Q3 Kwartaal"
 *   YEARLY    -> "2026 Jaar"
 *   FULL      -> "2026-09 Volledig"
 */
export function sessionSnapshotName(
  session: Pick<CountSession, "type" | "completedAt" | "startedAt">,
): string {
  const date = resolveSnapshotDate(session);
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12
  const dayOfMonth = date.getDate();
  const withinGraceDays = dayOfMonth <= PERIOD_GRACE_DAYS;
  switch (session.type) {
    case "MONTHLY": {
      if (withinGraceDays) {
        const previousMonth = month === 1 ? 12 : month - 1;
        const previousYear = month === 1 ? year - 1 : year;
        return `${previousYear}-${String(previousMonth).padStart(2, "0")} Maand`;
      }
      return `${year}-${String(month).padStart(2, "0")} Maand`;
    }
    case "QUARTERLY": {
      const quarter = Math.floor((month - 1) / 3) + 1;
      const isFirstMonthOfQuarter = (month - 1) % 3 === 0;
      if (isFirstMonthOfQuarter && withinGraceDays) {
        const previousQuarter = quarter === 1 ? 4 : quarter - 1;
        const previousYear = quarter === 1 ? year - 1 : year;
        return `${previousYear}-Q${previousQuarter} Kwartaal`;
      }
      return `${year}-Q${quarter} Kwartaal`;
    }
    case "YEARLY": {
      if (month === 1 && withinGraceDays) {
        return `${year - 1} Jaar`;
      }
      return `${year} Jaar`;
    }
    case "FULL":
      return `${year}-${String(month).padStart(2, "0")} Volledig`;
  }
}

function buildArticleSnapshot(
  article: Article,
  result: ArticleReviewResult | undefined,
): ArticleSnapshot {
  if (result && result.fullyCounted) {
    // Fysiek (volledig) afgehandeld deze sessie — hetzij effectief geteld,
    // hetzij expliciet bevestigd als "niet aanwezig / voorraad 0" (spec
    // v0.2.1 §5, `confirmedAbsent`). Beide zijn "echte" tellingen, nooit een
    // fictieve 0.
    return {
      articleId: article.id,
      article,
      status: result.confirmedAbsent ? "0 BEVESTIGD" : "GETELD",
      totalCount: result.newTotalCount,
      previousCount: result.previousCount,
      differenceQuantity: result.differenceQuantity,
      costPrice: result.costPrice,
      previousValue: result.previousValue,
      amount: result.amount,
      differenceAmount: result.differenceAmount,
      perLocation: result.perLocation,
      note: result.note,
    };
  }

  if (result) {
    // Aanvulling ("Afronden met openstaande artikels"): dit artikel zat WEL
    // in de sessiescope (er bestaat een reviewresultaat), maar werd niet
    // (volledig) fysiek geteld/opgelost — dit kan enkel gebeuren na een
    // UITZONDERLIJKE afronding (`CountSessionService.completeSessionWithOutstandingArticles`),
    // want de normale, strikte afronding blokkeert dit anders altijd (zie
    // `isSessionReadyToComplete`). Semantisch verschillend van OVERGENOMEN
    // hieronder: dat artikel had NOOIT iets met deze sessie te maken, dit
    // artikel wel — het is bewust overgeslagen. Zelfde kernregel: NOOIT
    // automatisch 0, `Article.previousCount` verandert hierdoor niet (zie
    // `buildNextPreviousCounts` hieronder, die dit al correct afhandelt via
    // dezelfde `!result.fullyCounted`-voorwaarde). `perLocation`/`note`
    // hergebruiken de ECHTE (eventueel gedeeltelijke) reviewgegevens — nooit
    // fictief, maar ook niets verbergen.
    const previousCount = article.previousCount;
    const costPrice = article.costPrice;
    const previousValue = previousCount !== null && costPrice !== null ? previousCount * costPrice : null;
    return {
      articleId: article.id,
      article,
      status: "OVERGENOMEN - NIET GETELD",
      totalCount: previousCount,
      previousCount,
      differenceQuantity: previousCount !== null ? 0 : null,
      costPrice,
      previousValue,
      amount: previousValue,
      differenceAmount: previousCount !== null ? 0 : null,
      perLocation: result.perLocation,
      note: result.note,
    };
  }

  // Geen reviewresultaat: dit artikel zat NOOIT in de scope van deze sessie
  // (bv. een kwartaalartikel tijdens een maandtelling). KERNREGEL: dit mag
  // NOOIT automatisch 0 worden — de laatst bekende geldige fysieke telling
  // (`Article.previousCount`) wordt overgenomen. `Article.previousCount`
  // wordt uitsluitend bijgewerkt wanneer een sessie het artikel effectief
  // volledig telde (zie `review.ts#buildNextPreviousCounts` /
  // `CountSessionService`), dus dit veld is al exact "de laatste fysieke
  // telling, ongeacht hoeveel tussenliggende OVERGENOMEN(-NIET-GETELD)-cycli
  // er waren" — geen nieuwe trackinglogica nodig, enkel correct hergebruik.
  const previousCount = article.previousCount;
  const costPrice = article.costPrice;
  const previousValue = previousCount !== null && costPrice !== null ? previousCount * costPrice : null;
  return {
    articleId: article.id,
    article,
    status: "OVERGENOMEN",
    totalCount: previousCount,
    previousCount,
    differenceQuantity: previousCount !== null ? 0 : null,
    costPrice,
    previousValue,
    amount: previousValue,
    differenceAmount: previousCount !== null ? 0 : null,
    perLocation: [],
    note: null,
  };
}

/**
 * Bouwt de volledige voorraad-snapshot van een sessie: één ArticleSnapshot
 * voor ELK artikel van het kantoor (niet enkel de sessiescope), door
 * `computeSessionReview`s resultaat te hergebruiken/verrijken met
 * OVERGENOMEN-rijen voor de rest. Puur een berekening — schrijft niets.
 */
export function buildSessionSnapshot(
  session: Pick<CountSession, "id" | "type" | "completedAt" | "startedAt">,
  allArticles: Article[],
  review: SessionReviewSummary,
): StockSnapshot {
  const resultByArticleId = new Map(review.results.map((r) => [r.articleId, r]));
  return {
    sessionId: (session as CountSession).id,
    sessionType: session.type,
    sessionName: sessionSnapshotName(session),
    snapshotDate: isoDateFromLocalDate(resolveSnapshotDate(session)),
    articles: allArticles.map((article) => buildArticleSnapshot(article, resultByArticleId.get(article.id))),
    provenance: "APP_COUNT",
  };
}

/**
 * Sprint 3.3 §1 (legacy Analyse/Vergelijken zonder fake CountSessions):
 * synthetiseert een `StockSnapshot`-vormig object voor ÉÉN legacy periode,
 * uit de reeds geïmporteerde `StockHistoryEntry`-regels van die periode
 * (`domain/legacyImport.ts#buildLegacyHistoryEntry`, `status: "LEGACY"`,
 * `source: "LEGACY_IMPORT"`). Dit laat Analysis/Comparison een legacy
 * periode als A/B/vergelijkingspunt gebruiken via exact dezelfde
 * `StockSnapshot`/`ArticleSnapshot`-vorm als een echte sessie — ZONDER
 * ergens een fictieve `CountSession` te modelleren (spec: expliciet
 * verboden). `domain/comparison.ts`s kernberekeningen lezen toch enkel
 * `AnalysisArticleRow`s waarde-/identiteitsvelden (nooit sessie-review-
 * specifieke velden zoals `SessionReviewSummary`), dus deze ene
 * synthese-stap volstaat — geen enkele wijziging nodig aan
 * `buildArticleComparisonRows`/`buildKpis`/e.a.
 *
 * BEWUST enkel de artikelen die effectief een brondata-rij hadden in DEZE
 * periode (geen gefabriceerde OVERGENOMEN-doorrekening zoals een echte
 * sessie die wel doet, spec: "geen normale CountSession-semantiek
 * fabriceren") — een artikel zonder rij in deze periode is hier gewoon
 * ONBEKEND, niet stilzwijgend "ongewijzigd overgenomen".
 *
 * `resolvedArticlesById` moet de HUIDIGE (levende) artikelstam van dit
 * kantoor zijn — hetzelfde principe als `toAnalysisArticleRow`/
 * `getStockClassification`: de canonieke Productgamma/classificatie mag,
 * zoals afgesproken, retroactief toegepast worden. `articleNumber`/
 * `description`/`productGroup` worden WEL bevroren op de historische
 * bronwaarden van deze regel (frozen facts) — nooit de eventueel intussen
 * gewijzigde huidige waarden.
 */
export function buildLegacyPeriodSnapshot(
  sessionId: string,
  periodLabel: string,
  isoDate: string,
  entries: StockHistoryEntry[],
  resolvedArticlesById: ReadonlyMap<string, Article>,
): StockSnapshot {
  const articles: ArticleSnapshot[] = [];
  for (const entry of entries) {
    const resolvedArticle = resolvedArticlesById.get(entry.articleId);
    // Defensief: elke legacy-rij kreeg bij import altijd een levend of
    // nieuw historisch/inactief `Article`-record (zie
    // `LegacyImportService.commit`) — dit zou dus nooit mogen voorkomen,
    // maar een ontbrekend artikel mag hier nooit een crash veroorzaken; de
    // rij wordt dan gewoon overgeslagen (geen fictief artikel verzinnen).
    if (!resolvedArticle) continue;
    const totalCount = entry.totalCount;
    const costPrice = entry.costPrice;
    const amount = totalCount !== null && costPrice !== null ? totalCount * costPrice : null;
    const article: Article = {
      ...resolvedArticle,
      articleNumber: entry.articleNumber,
      description: entry.description,
      productGroup: entry.sourceProductGroup ?? resolvedArticle.productGroup,
    };
    articles.push({
      articleId: entry.articleId,
      article,
      status: "LEGACY",
      totalCount,
      previousCount: null,
      differenceQuantity: null,
      costPrice,
      previousValue: null,
      amount,
      differenceAmount: null,
      perLocation: [],
      note: null,
    });
  }
  return {
    sessionId,
    sessionType: "FULL",
    sessionName: legacySnapshotSessionName(periodLabel),
    snapshotDate: isoDate,
    articles,
    provenance: "LEGACY_IMPORT",
  };
}

/**
 * Zelfde naamgevingsconventie als `domain/legacyImport.ts#legacySessionName`
 * — hier lokaal herhaald (i.p.v. geïmporteerd) om een circulaire
 * afhankelijkheid tussen `stockSnapshot.ts` en `legacyImport.ts` te
 * vermijden (`legacyImport.ts` importeert zelf al `historyEntryKey` uit dit
 * bestand). Beide functies MOETEN letterlijk identiek blijven — zie de
 * test die dit expliciet afdwingt.
 */
function legacySnapshotSessionName(periodLabel: string): string {
  return `LEGACY ${periodLabel}`;
}

/**
 * Vervolg op "makkelijk vergelijken tussen toestellen": reconstrueert een
 * volledige `StockSnapshot` + bijhorende `SessionReviewSummary` voor een
 * sessie waarvan dit toestel de oorspronkelijke `CountSession`/`CountEntry`-
 * data NOOIT lokaal gehad heeft — enkel de reeds geïmporteerde,
 * machinevriendelijke HISTORIE-regels (`StockHistoryEntry[]`, `source` ≠
 * `"LEGACY_IMPORT"`, dus een ECHTE, vroeger op een ANDER toestel afgeronde
 * app-sessie, niet een legacy periode van vóór deze app). `ImportService`
 * gebruikt dit om zo'n sessie als een volwaardige, lokale `CountSession`
 * (status COMPLETED) + `FinalizedSessionResult` te bewaren — waarna ZOWEL
 * "Vorige tellingen" (Home) als "Analyse telling" als "Vergelijken" haar
 * ONGEWIJZIGD gewoon behandelen als eender welke andere afgeronde sessie van
 * dit kantoor (geen enkele wijziging nodig aan
 * HomePage/AnalysisService/ComparisonService/ExportService).
 *
 * BEWUSTE PRECISIE-BEPERKING (zie `StockSource.ts#HistoricalSheetSnapshot`:
 * "rows is bewust ondoorzichtig voor het domein"): de machinevriendelijke
 * HISTORIE-regel is de enige structured bron die een geïmporteerd bestand op
 * eender welk toestel leesbaar houdt, maar bewaart nooit per-locatie-detail
 * of welke artikelen destijds via "+ Bestaand artikel opzoeken" buiten de
 * sessiescope geteld werden. Voor zo'n gereconstrueerde sessie betekent dit
 * onvermijdelijk:
 *   - `perLocation` is altijd leeg (geen "op welk rek geteld").
 *   - `isManualAddition` is altijd `false` ("nieuwe artikelen gevonden" toont
 *     dus 0 voor zo'n sessie, ook al waren er destijds mogelijk enkele).
 *   - `note`/`flaggedForControl` zijn altijd leeg/`false`.
 * Alle AANTALLEN/WAARDES/VERSCHILLEN (en dus elke Analyse-KPI, elke
 * Vergelijken-berekening, en een eventuele volgende export) blijven wél
 * 100% exact — die komen rechtstreeks uit de reeds bevroren HISTORIE-cijfers,
 * nooit herberekend of geraden.
 *
 * Artikelen met status `"OVERGENOMEN"` (nooit in de sessiescope, zie
 * `ArticleSnapshotStatus`) komen wel in de snapshot terecht (zoals elke
 * snapshot altijd alle artikelen van het kantoor bevat), maar bewust niet in
 * `review.results`/de scope-totalen — exact dezelfde regel als
 * `computeSessionReview` voor een echte sessie.
 *
 * `entries` moet minstens 1 regel bevatten en volledig tot ÉÉN sessienaam
 * behoren (`sessionType`/`sessionName`/`countDate` worden van de eerste
 * regel afgeleid — de aanroeper groepeert hierop al, zie `ImportService`).
 */
export function buildSnapshotAndReviewFromHistory(
  sessionId: string,
  entries: StockHistoryEntry[],
  resolvedArticlesById: ReadonlyMap<string, Article>,
): { snapshot: StockSnapshot; review: SessionReviewSummary } {
  const articles: ArticleSnapshot[] = [];
  const results: ArticleReviewResult[] = [];

  let countedArticles = 0;
  let articlesWithDifference = 0;
  let totalPositiveCorrectionQuantity = 0;
  let totalNegativeCorrectionQuantity = 0;
  let totalPositiveCorrectionAmount = 0;
  let totalNegativeCorrectionAmount = 0;

  for (const entry of entries) {
    const resolvedArticle = resolvedArticlesById.get(entry.articleId);
    // Defensief, zoals buildLegacyPeriodSnapshot hierboven: zou nooit mogen
    // voorkomen (elke HISTORIE-regel kreeg bij import altijd een bestaand of
    // nieuw Article-record), maar nooit crashen op een ontbrekend artikel.
    if (!resolvedArticle) continue;

    const article: Article = {
      ...resolvedArticle,
      articleNumber: entry.articleNumber,
      description: entry.description,
    };
    const totalCount = entry.totalCount;
    const costPrice = entry.costPrice;
    const previousCount = entry.previousCount;
    const previousValue = previousCount !== null && costPrice !== null ? previousCount * costPrice : null;
    const amount = totalCount !== null && costPrice !== null ? totalCount * costPrice : null;

    articles.push({
      articleId: entry.articleId,
      article,
      status: entry.status,
      totalCount,
      previousCount,
      differenceQuantity: entry.differenceQuantity,
      costPrice,
      previousValue,
      amount,
      differenceAmount: entry.differenceAmount,
      perLocation: [],
      note: null,
    });

    if (entry.status === "OVERGENOMEN") continue; // nooit in sessiescope, zie hierboven.

    const fullyCounted = entry.status === "GETELD" || entry.status === "0 BEVESTIGD";
    results.push({
      articleId: entry.articleId,
      article,
      previousCount,
      perLocation: [],
      fullyCounted,
      newTotalCount: totalCount,
      differenceQuantity: entry.differenceQuantity,
      costPrice,
      previousValue,
      amount,
      differenceAmount: entry.differenceAmount,
      note: null,
      isManualAddition: false,
      hasAnyEntry: fullyCounted,
      confirmedAbsent: entry.status === "0 BEVESTIGD",
      flaggedForControl: false,
    });

    if (fullyCounted) countedArticles += 1;
    if (entry.differenceQuantity !== null && entry.differenceQuantity !== 0) {
      articlesWithDifference += 1;
      if (entry.differenceQuantity > 0) {
        totalPositiveCorrectionQuantity += entry.differenceQuantity;
      } else {
        totalNegativeCorrectionQuantity += entry.differenceQuantity;
      }
    }
    if (entry.differenceAmount !== null && entry.differenceAmount !== 0) {
      if (entry.differenceAmount > 0) {
        totalPositiveCorrectionAmount += entry.differenceAmount;
      } else {
        totalNegativeCorrectionAmount += entry.differenceAmount;
      }
    }
  }

  const first = entries[0];
  const snapshot: StockSnapshot = {
    sessionId,
    sessionType: first.sessionType,
    sessionName: first.sessionName,
    snapshotDate: first.countDate,
    articles,
    provenance: "APP_COUNT",
  };
  const review: SessionReviewSummary = {
    totalArticlesInScope: results.length,
    countedArticles,
    notCountedArticles: results.length - countedArticles,
    articlesWithDifference,
    totalPositiveCorrectionQuantity,
    totalNegativeCorrectionQuantity,
    totalPositiveCorrectionAmount,
    totalNegativeCorrectionAmount,
    results,
    // Deze sessie was elders al volledig afgerond — er is hier lokaal geen
    // enkele locatie om nog "af te ronden", dus bewust neutrale/lege
    // waarden: niets leest dit voor een COMPLETED sessie (zie AnalysisService/
    // ComparisonService, die uitsluitend totalArticlesInScope/countedArticles/
    // results lezen), dit bestaat puur om het SessionReviewSummary-type
    // volledig in te vullen.
    allLocationsCompleted: true,
    totalActiveLocations: 0,
    completedActiveLocationsCount: 0,
    incompleteActiveLocations: [],
    notFoundAnywhere: results.filter((r) => !r.hasAnyEntry),
  };
  return { snapshot, review };
}

/**
 * Leidt de machinevriendelijke HISTORIE-regels af uit een snapshot — één
 * regel per artikel, inclusief OVERGENOMEN-artikelen (spec: het
 * kwartaalartikel-voorbeeld toont expliciet dat OVERGENOMEN-maanden ook in
 * HISTORIE terechtkomen, anders kan de "vorige fysieke telling" niet correct
 * herleid worden uit een geïmporteerd bestand op een nieuw toestel).
 */
export function buildHistoryEntriesFromSnapshot(
  snapshot: StockSnapshot,
  locations: Location[],
): StockHistoryEntry[] {
  const locationById = new Map(locations.map((l) => [l.id, l]));
  return snapshot.articles.map((articleSnapshot) => {
    const locationNames = articleSnapshot.perLocation
      .filter((l) => l.hasEntry)
      .map((l) => locationById.get(l.locationId)?.name)
      .filter((name): name is string => Boolean(name))
      .sort((a, b) => a.localeCompare(b, "nl"));
    return {
      countDate: snapshot.snapshotDate,
      sessionType: snapshot.sessionType,
      sessionName: snapshot.sessionName,
      articleId: articleSnapshot.articleId,
      articleNumber: articleSnapshot.article.articleNumber,
      description: articleSnapshot.article.description,
      totalCount: articleSnapshot.totalCount,
      previousCount: articleSnapshot.previousCount,
      differenceQuantity: articleSnapshot.differenceQuantity,
      costPrice: articleSnapshot.costPrice,
      differenceAmount: articleSnapshot.differenceAmount,
      status: articleSnapshot.status,
      locationNames,
      // Stabiele identiteit over toestellen heen (zie StockHistoryEntry#sourceSessionId
      // hierboven) — `snapshot.sessionId` is hier altijd het echte, originele
      // CountSession.id (deze functie wordt nooit voor een legacy periode
      // aangeroepen, enkel voor een echte of eerder al herstelde app-sessie).
      sourceSessionId: snapshot.sessionId,
    };
  });
}

/** Dedupsleutel voor een HISTORIE-regel: één regel per (artikel, snapshot/tellingnaam). */
export function historyEntryKey(entry: Pick<StockHistoryEntry, "sessionName" | "articleId">): string {
  return `${entry.sessionName}::${entry.articleId}`;
}

/**
 * Voegt nieuw berekende HISTORIE-regels samen met reeds gekende (geïmporteerd
 * en/of eerder deze sessie geëxporteerd) regels, zonder duplicaten (spec:
 * "export -> herimport mag geen duplicaten creëren"). Bij eenzelfde
 * (artikel, tellingnaam) wint `incoming` — dat is altijd de vers herberekende
 * versie voor die snapshot. Resultaat chronologisch gesorteerd.
 */
export function mergeHistoryEntries(
  existing: StockHistoryEntry[],
  incoming: StockHistoryEntry[],
): StockHistoryEntry[] {
  const byKey = new Map<string, StockHistoryEntry>();
  for (const entry of existing) {
    byKey.set(historyEntryKey(entry), entry);
  }
  for (const entry of incoming) {
    byKey.set(historyEntryKey(entry), entry);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const dateCompare = a.countDate.localeCompare(b.countDate);
    if (dateCompare !== 0) return dateCompare;
    return a.sessionName.localeCompare(b.sessionName, "nl");
  });
}
