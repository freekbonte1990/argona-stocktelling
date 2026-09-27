import { computeFrequencyBreakdown, type FrequencyBreakdown } from "../../domain/frequency";
import { activeLocationsInOrder, mergeArticleLocationAssignments } from "../../domain/locations";
import { mergeHistoryEntries } from "../../domain/stockSnapshot";
import type { StockHistoryEntry } from "../../domain/stockSnapshot";
import type { Article, ArticleLocationAssignment, Office, ProductCategory } from "../../domain/types";
import type { CountingRepository } from "../ports/CountingRepository";
import type { HistoricalSheetSnapshot, StockSource } from "../ports/StockSource";

export interface ExistingOfficeInfo {
  office: Office;
  articleCount: number;
  importedAt: string | null;
  hasActiveSession: boolean;
}

/**
 * Resultaat van het INLEZEN (nog niet bewaren) van een bron. Bevat alles wat
 * nodig is om ofwel meteen te bewaren, ofwel eerst een waarschuwing te tonen
 * wanneer dit kantoor al bestond (spec: "niet stilletjes overschrijven").
 */
export interface ImportPreview {
  office: Office;
  articles: Article[];
  sourceLabel: string;
  totalArticles: number;
  breakdown: FrequencyBreakdown;
  /** Ingevuld wanneer er al een kantoor met hetzelfde ID (naam) bestond. */
  existing: ExistingOfficeInfo | null;
  /**
   * Rollend stockarchief (spec): telhistoriek (sheet HISTORIE) en historische,
   * benoemde tellingtabs uit het bronbestand — leeg wanneer de bron dit niet
   * ondersteunt (`StockSource.loadHistory`/`loadHistoricalSheets` zijn
   * optioneel) of het bestand deze sheets niet had (backward compat, oudere
   * gestandaardiseerde bestanden zonder rollend archief).
   */
  historyEntries: StockHistoryEntry[];
  historicalSheets: HistoricalSheetSnapshot[];
  /**
   * Production-pilot-readiness sprint punt 1 ("Excel portability"): geleerde
   * `ArticleLocationAssignment`'s uit sheet ARTIKEL_LOCATIES — leeg wanneer de
   * bron dit niet ondersteunt (`StockSource.loadArticleLocationAssignments`
   * is optioneel) of het bestand deze sheet niet had (backward compat, een
   * bestand van vóór deze sprint).
   */
  assignments: ArticleLocationAssignment[];
  /**
   * Sprint 3.2 §14 (Excel portability): de bedrijfsbrede/globale
   * Productgamma-lijst uit sheet PRODUCTGAMMAS — leeg wanneer de bron dit
   * niet ondersteunt (`StockSource.loadProductCategories` is optioneel) of
   * het bestand deze sheet niet had (backward compat, een bestand van vóór
   * Sprint 3.2).
   */
  categories: ProductCategory[];
}

/**
 * Production-pilot-readiness sprint punt 4 ("Importcontrole"): een compacte
 * samenvatting van wat de import hersteld/geleerd heeft, voor onmiddellijke
 * feedback ná het importeren — `null` waar dat niet van toepassing/gekend is
 * (bv. een kantoor zonder enige historische telling).
 */
export interface LastHistoricalCountSummary {
  sessionName: string;
  countDate: string;
}

export interface ImportSummary {
  office: Office;
  totalArticles: number;
  breakdown: FrequencyBreakdown;
  sourceFileName: string;
  /** Aantal ACTIEVE locaties van dit kantoor ná import (spec punt 4). */
  activeLocationCount: number;
  /** Meest recente historische telling die nu voor dit kantoor gekend is, indien beschikbaar (spec punt 4). */
  lastHistoricalCount: LastHistoricalCountSummary | null;
}

/**
 * Orkestreert een import: haalt kantoor + artikelen op via een StockSource
 * (vandaag: Excel, later evt. eBuddy) en bewaart ze via de
 * CountingRepository. Opsplitsen in `prepareImport` (enkel lezen) en
 * `commitImport` (effectief bewaren) laat de UI toe om, wanneer een kantoor
 * al bestaat, eerst een begrijpelijke keuze te tonen in plaats van
 * stilletjes te overschrijven.
 *
 * Bevat zelf geen Excel- of IndexedDB-specifieke kennis: die zit volledig in
 * de adapters die hier binnenkomen.
 */
export class ImportService {
  private readonly repository: CountingRepository;

  constructor(repository: CountingRepository) {
    this.repository = repository;
  }

  async prepareImport(source: StockSource): Promise<ImportPreview> {
    const office = await source.loadOffice();
    const articles = await source.loadArticles(office);
    // Alle drie optioneel (zie StockSource) — een bron/bestand zonder rollend
    // archief resp. zonder geleerde locatiekoppelingen geeft hier gewoon
    // niets terug, nooit een fout.
    const [historyEntries, historicalSheets, assignments, categories] = await Promise.all([
      source.loadHistory?.() ?? Promise.resolve([]),
      source.loadHistoricalSheets?.() ?? Promise.resolve([]),
      source.loadArticleLocationAssignments?.() ?? Promise.resolve([]),
      source.loadProductCategories?.() ?? Promise.resolve([]),
    ]);

    const existingOffice = await this.repository.getOffice(office.id);
    let existing: ExistingOfficeInfo | null = null;
    if (existingOffice) {
      const [existingArticles, activeSession, meta] = await Promise.all([
        this.repository.getArticles(office.id),
        this.repository.getActiveSession(office.id),
        this.repository.getImportMeta(office.id),
      ]);
      existing = {
        office: existingOffice,
        articleCount: existingArticles.length,
        importedAt: meta?.importedAt ?? null,
        hasActiveSession: activeSession !== undefined,
      };
    }

    return {
      office,
      articles,
      sourceLabel: source.sourceLabel,
      totalArticles: articles.length,
      breakdown: computeFrequencyBreakdown(articles),
      existing,
      historyEntries,
      historicalSheets,
      assignments,
      categories,
    };
  }

  /**
   * Bewaart een eerder ingelezen preview. Bij een bestaand kantoor blijven de
   * (mogelijk door de gebruiker aangepaste) locatienamen behouden — enkel
   * artikelgegevens en basisdatum worden vervangen door het nieuwe bestand.
   */
  async commitImport(preview: ImportPreview): Promise<ImportSummary> {
    const office: Office = preview.existing
      ? { ...preview.office, locations: preview.existing.office.locations }
      : preview.office;

    await this.repository.saveOffice(office);
    await this.repository.saveArticles(preview.articles);
    await this.repository.saveImportMeta({
      officeId: office.id,
      sourceFileName: preview.sourceLabel,
      importedAt: new Date().toISOString(),
    });
    await this.repository.setSelectedOfficeId(office.id);

    // Rollend stockarchief (spec): herkent bestaande historische
    // tellingtabs uit het bronbestand en maakt de historiek beschikbaar voor
    // ArticleDetail/history — ook op een nieuw toestel zonder lokale
    // CountSessions. Puur additief: leeg bij een ouder, gestandaardiseerd
    // bestand zonder rollend archief (backward compat).
    if (preview.historicalSheets.length > 0) {
      // Een reeds LOKAAL gekende sheetnaam (bv. zelf eerder bevroren via een
      // export in DEZE repository, met een gekende sessionId) wordt nooit
      // overschreven/gedowngraded door een import — dat zou de koppeling met
      // die sessie verliezen (nodig voor ExportService's hergebruik- i.p.v.
      // conflictlogica bij een latere, herhaalde export van diezelfde
      // sessie). Enkel écht nieuwe sheetnamen worden toegevoegd.
      const existingSheets = await this.repository.getHistoricalSheetSnapshots(office.id);
      const existingSheetNames = new Set(existingSheets.map((s) => s.sheetName));
      for (const sheet of preview.historicalSheets) {
        if (existingSheetNames.has(sheet.sheetName)) continue;
        await this.repository.saveHistoricalSheetSnapshot({
          officeId: office.id,
          sessionId: null,
          sheetName: sheet.sheetName,
          rows: sheet.rows,
        });
      }
    }
    let mergedHistory = await this.repository.getStockHistoryEntries(office.id);
    if (preview.historyEntries.length > 0) {
      mergedHistory = mergeHistoryEntries(mergedHistory, preview.historyEntries);
      await this.repository.saveStockHistoryEntries(office.id, mergedHistory);
    }

    // Production-pilot-readiness sprint punt 1 ("Excel portability"): geleerde
    // locatiekoppelingen uit ARTIKEL_LOCATIES additief samenvoegen met wat dit
    // toestel eventueel al lokaal wist (zie `mergeArticleLocationAssignments`
    // — een volledig lege/verse repository heeft hier simpelweg nog niets
    // lokaal, dus het geïmporteerde bestand bepaalt dan alles).
    if (preview.assignments.length > 0) {
      const existingAssignments = await this.repository.getArticleLocationAssignments(office.id);
      const merged = mergeArticleLocationAssignments(existingAssignments, preview.assignments);
      await this.repository.saveArticleLocationAssignments(merged);
    }

    // Sprint 3.2 §14 (Excel portability): de globale Productgamma-lijst
    // additief samenvoegen — zelfde precedent als de historische tabs/
    // ArticleLocationAssignments hierboven ("existing-wins-on-ID-conflict"):
    // een categorie-ID die dit toestel al lokaal kent (mogelijk intussen
    // hernoemd/heringedeeld/gedeactiveerd door de gebruiker) wordt NOOIT
    // overschreven door de import — enkel categorie-ID's die dit toestel nog
    // niet kende, worden toegevoegd. Dat garandeert zowel de "volledig lege
    // database" fresh-repository-scenario (alles komt gewoon binnen, er is
    // nog niets lokaal) als de "opnieuw importeren op een reeds bewerkt
    // toestel"-scenario (lokale beheeracties blijven behouden).
    if (preview.categories.length > 0) {
      const existingCategories = await this.repository.getProductCategories();
      const existingCategoryIds = new Set(existingCategories.map((c) => c.id));
      const newCategories = preview.categories.filter((c) => !existingCategoryIds.has(c.id));
      if (newCategories.length > 0) {
        await this.repository.saveProductCategories(newCategories);
      }
    }

    // Production-pilot-readiness sprint punt 4 ("Importcontrole"): compacte
    // bevestiging na import — de meest recente historische telling (indien
    // gekend) en het aantal actieve locaties, zodat de gebruiker meteen kan
    // zien dat de import het juiste, volledige kantoor herstelde.
    const lastHistoricalCount =
      mergedHistory.length > 0
        ? mergedHistory.reduce((latest, entry) =>
            entry.countDate.localeCompare(latest.countDate) > 0 ? entry : latest,
          )
        : null;

    return {
      office,
      totalArticles: preview.totalArticles,
      breakdown: preview.breakdown,
      sourceFileName: preview.sourceLabel,
      activeLocationCount: activeLocationsInOrder(office).length,
      lastHistoricalCount: lastHistoricalCount
        ? { sessionName: lastHistoricalCount.sessionName, countDate: lastHistoricalCount.countDate }
        : null,
    };
  }
}
