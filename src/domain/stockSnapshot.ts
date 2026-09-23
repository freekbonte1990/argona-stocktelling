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
 */
export type ArticleSnapshotStatus =
  | "GETELD"
  | "0 BEVESTIGD"
  | "OVERGENOMEN"
  | "OVERGENOMEN - NIET GETELD";

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
 * Genereert de vaste naamgevingsconventie voor tellingtabbladen, uitsluitend
 * op basis van `CountSession.type` en `completedAt` (spec):
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
  switch (session.type) {
    case "MONTHLY":
      return `${year}-${String(month).padStart(2, "0")} Maand`;
    case "QUARTERLY": {
      const quarter = Math.floor((month - 1) / 3) + 1;
      return `${year}-Q${quarter} Kwartaal`;
    }
    case "YEARLY":
      return `${year} Jaar`;
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
  };
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
