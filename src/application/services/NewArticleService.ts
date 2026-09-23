import { FREQUENCY_TO_RAW } from "../../domain/frequency";
import { assertValidQuantity } from "../../domain/quantityValidation";
import { generateTempArticleNumber } from "../../domain/tempArticleNumber";
import type { Article, ArticleCountFrequency, CountSession } from "../../domain/types";
import { assertSessionEditable } from "../errors";
import type { CountingRepository } from "../ports/CountingRepository";
import type { CountingService } from "./CountingService";
import type { LocationAssignmentService } from "./LocationAssignmentService";

/** Gemeenschappelijke, minimale velden voor een handmatig aangemaakt artikel. */
interface NewArticleCoreInput {
  description: string;
  productGroup: string;
  unit: string;
  countPeriod: ArticleCountFrequency;
  supplier?: string | null;
  costPrice?: number | null;
  comment?: string | null;
}

/** Part 3A: "+ Nieuw artikel" vanuit het Artikels-overzicht. */
export interface NewArticleInput extends NewArticleCoreInput {
  /** Eén of meerdere stocklocaties waaraan het artikel meteen gekoppeld wordt (optioneel). */
  locationIds?: string[];
}

/** Part 3B: "+ Nieuw artikel gevonden" vanuit een lopende telling. */
export interface NewArticleFoundDuringCountingInput extends NewArticleCoreInput {
  /** Expliciete `0` is een geldige, volwaardige hoeveelheid (spec: nooit met `quantity` alleen bepalen of iets geteld is — hier gebruiken we altijd `counted=true` via CountingService#recordCount). */
  quantity: number;
}

/**
 * Orchestreert het aanmaken van artikelen die nog niet in de artikelstam
 * staan (v0.2.1 correctieronde §3). Genereert zelf NOOIT een officieel
 * ERP/eBuddy-artikelnummer — enkel een herkenbaar tijdelijk nummer
 * (`domain/tempArticleNumber.ts`), gemarkeerd met `idType: "TIJDELIJK"`.
 *
 * Hergebruikt bewust de bestaande `LocationAssignmentService` (voor de
 * locatiekoppeling) en `CountingService#recordCount` (voor de telling vanuit
 * een lopende sessie) — geen tweede, parallel opslagpad.
 */
export class NewArticleService {
  private readonly repository: CountingRepository;
  private readonly locationAssignmentService: LocationAssignmentService;
  private readonly countingService: CountingService;

  constructor(
    repository: CountingRepository,
    locationAssignmentService: LocationAssignmentService,
    countingService: CountingService,
  ) {
    this.repository = repository;
    this.locationAssignmentService = locationAssignmentService;
    this.countingService = countingService;
  }

  private async buildNewArticle(officeId: string, input: NewArticleCoreInput): Promise<Article> {
    const [office, existingArticles] = await Promise.all([
      this.repository.getOffice(officeId),
      this.repository.getArticles(officeId),
    ]);
    if (!office) {
      throw new Error(`Kantoor ${officeId} niet gevonden.`);
    }
    const articleNumber = generateTempArticleNumber(office.name, existingArticles);
    const description = input.description.trim();
    if (!description) {
      throw new Error("Omschrijving is verplicht voor een nieuw artikel.");
    }
    return {
      id: `${officeId}:${articleNumber}`,
      officeId,
      articleNumber,
      officialArticleNumber: null,
      idType: "TIJDELIJK",
      description,
      productGroup: input.productGroup.trim() || null,
      supplier: input.supplier?.trim() || null,
      unit: input.unit.trim() || null,
      costPrice: input.costPrice ?? null,
      rawCountPeriod: FREQUENCY_TO_RAW[input.countPeriod],
      countPeriod: input.countPeriod,
      rawStatus: "ACTIEF",
      status: "ACTIVE",
      previousCount: null,
      sourceRow: null,
      comment: input.comment?.trim() || null,
    };
  }

  /** Part 3A. */
  async createArticle(officeId: string, input: NewArticleInput): Promise<Article> {
    const article = await this.buildNewArticle(officeId, input);
    await this.repository.saveArticles([article]);
    for (const locationId of input.locationIds ?? []) {
      await this.locationAssignmentService.addLocation(officeId, [article.id], locationId);
    }
    return article;
  }

  /**
   * Part 3B. Volgt exact de 4 stappen uit de spec:
   *   1. artikel aanmaken met tijdelijk nummer;
   *   2. ArticleLocationAssignment naar de huidige locatie;
   *   3+4. CountEntry met de ingegeven hoeveelheid (via de bestaande
   *        CountingService, die ook meteen de locatie "leert" — hetzelfde
   *        pad als een gewone telling).
   *   (5. verschijnt automatisch in Review — dat volgt reeds uit
   *        domain/review.ts, dat elk artikel met entries buiten
   *        `session.articleIds` als "handmatige toevoeging" herkent; er is
   *        geen extra code nodig om het artikel zelf aan de sessie te
   *        "koppelen".)
   */
  async createArticleFoundDuringCounting(
    session: CountSession,
    locationId: string,
    input: NewArticleFoundDuringCountingInput,
  ): Promise<Article> {
    // Data-integriteit-sprint §1/§6/§8: BEIDE controles vooraan, VÓÓR enige
    // schrijfactie (artikel/locatiekoppeling/telling) — anders zou een
    // ongeldige hoeveelheid of een niet-ACTIEVE sessie een half aangemaakt
    // ("wees") artikel kunnen achterlaten (wel al opgeslagen, maar zonder
    // geldige telling).
    assertSessionEditable(session);
    assertValidQuantity(input.quantity);
    const article = await this.buildNewArticle(session.officeId, input);
    await this.repository.saveArticles([article]);
    await this.locationAssignmentService.addLocation(session.officeId, [article.id], locationId);
    await this.countingService.recordCount({
      session,
      articleId: article.id,
      locationId,
      quantity: input.quantity,
      note: "Nieuw artikel gevonden tijdens telling (handmatig toegevoegd).",
    });
    return article;
  }
}
