import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import { ExportService } from "../../application/services/ExportService";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";
import type { Article, Office } from "../../domain/types";

/**
 * Aanvulling: "Afronden met openstaande artikels" — end-to-end bewijs van het
 * spec-voorbeeld: een kwartaalartikel met vorige fysieke telling 12, dat
 * tijdens een VOLLEDIGE telling wel in scope zit maar bewust niet geteld
 * wordt (uitzonderlijke afronding) -> "OVERGENOMEN - NIET GETELD" 12, en pas
 * bij de volgende ECHTE fysieke (kwartaal)telling op 9 -> verschil -3 t.o.v.
 * de oorspronkelijke 12 (NIET t.o.v. de "OVERGENOMEN - NIET GETELD"-snapshot
 * zelf, al is die toevallig ook 12).
 */
const office: Office = {
  id: "office-1",
  name: "Damme",
  baseDate: "2026-01-01",
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
};

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: "office-1:Q1",
    officeId: "office-1",
    articleNumber: "Q1",
    officialArticleNumber: "Q1",
    idType: "OFFICIEEL",
    description: "Kwartaalartikel",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 1,
    rawCountPeriod: "KWARTAAL",
    countPeriod: "QUARTERLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 12, // "Q2 fysieke telling = 12" — het startpunt van het spec-voorbeeld.
    sourceRow: 1,
    ...overrides,
  };
}

describe("aanvulling — 'Afronden met openstaande artikels' in het rollend archief", () => {
  let repository: InMemoryCountingRepository;
  let sessionService: CountSessionService;
  let countingService: CountingService;
  let exportService: ExportService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    sessionService = new CountSessionService(repository);
    countingService = new CountingService(repository);
    exportService = new ExportService(repository, new ExcelStockResultExporter());
    await repository.saveOffice(office);
    await repository.saveArticles([makeArticle()]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bewaart de vorige FYSIEKE telling (12) doorheen een uitzonderlijk afgeronde sessie, tot de volgende echte fysieke telling (9, verschil -3)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    // Augustus: VOLLEDIGE telling (scope = alle artikelen, dus ook Q1), maar
    // Q1 wordt bewust NIET geteld -> "Afronden met openstaande artikels".
    vi.setSystemTime(new Date(2026, 7, 20));
    const august = await sessionService.startSession("office-1", "FULL");
    expect(august.articleIds).toContain("office-1:Q1");
    await sessionService.completeSessionWithOutstandingArticles(august.id);

    // Article.previousCount blijft 12 — NIET gewijzigd alsof er een nieuwe
    // fysieke telling gebeurde.
    const afterAugust = await repository.getArticles("office-1");
    expect(afterAugust.find((a) => a.id === "office-1:Q1")?.previousCount).toBe(12);
    // Geen fictieve CountEntry/locatiekoppeling voor Q1 in augustus.
    expect(
      (await repository.getCountEntries(august.id)).filter((e) => e.articleId === "office-1:Q1"),
    ).toHaveLength(0);
    expect(
      (await repository.getArticleLocationAssignments("office-1")).filter(
        (a) => a.articleId === "office-1:Q1",
      ),
    ).toHaveLength(0);

    const augustExport = await exportService.exportSessionResults(august.id);
    const augustRows = augustExport.newHistoricalSheet?.rows ?? [];
    const augustHeader = augustRows[0] as string[];
    const statusCol = augustHeader.indexOf("Status telling");
    const articleCol = augustHeader.indexOf("Artikelnr.");
    const previousCol = augustHeader.indexOf("Vorige telling");
    const diffCol = augustHeader.indexOf("Verschil aantal");
    const q1AugustRow = augustRows.find(
      (row) => Array.isArray(row) && row[articleCol] === "Q1",
    ) as unknown[];
    // De Excel-snapshot toont de duidelijk onderscheiden status, met de
    // exacte, door de gebruiker gesuggereerde zichtbare tekst.
    expect(q1AugustRow[statusCol]).toBe("OVERGENOMEN - NIET GETELD");
    expect(q1AugustRow[previousCol]).toBe(12);
    expect(q1AugustRow[diffCol]).toBe(0);

    // September: ECHTE kwartaaltelling, Q1 nu fysiek geteld op 9.
    vi.setSystemTime(new Date(2026, 8, 30));
    const september = await sessionService.startSession("office-1", "QUARTERLY");
    await countingService.recordCount({
      session: september,
      articleId: "office-1:Q1",
      locationId: "office-1:loc-1",
      quantity: 9,
    });
    await countingService.completeLocation(september.id, "office-1:loc-1");
    await sessionService.completeSession(september.id);

    const septemberExport = await exportService.exportSessionResults(september.id);
    const septRows = septemberExport.newHistoricalSheet?.rows ?? [];
    const septHeader = septRows[0] as string[];
    const sStatusCol = septHeader.indexOf("Status telling");
    const sArticleCol = septHeader.indexOf("Artikelnr.");
    const sPreviousCol = septHeader.indexOf("Vorige telling");
    const sNewCol = septHeader.indexOf("Nieuwe telling");
    const sDiffCol = septHeader.indexOf("Verschil aantal");
    const q1SeptRow = septRows.find((row) => Array.isArray(row) && row[sArticleCol] === "Q1") as unknown[];

    expect(q1SeptRow[sStatusCol]).toBe("GETELD");
    // Kern van het spec-voorbeeld: de vorige fysieke telling voor september
    // blijft 12 (de ECHTE Q2-telling), niet vervormd door de tussentijdse
    // "OVERGENOMEN - NIET GETELD"-snapshot van augustus.
    expect(q1SeptRow[sPreviousCol]).toBe(12);
    expect(q1SeptRow[sNewCol]).toBe(9);
    expect(q1SeptRow[sDiffCol]).toBe(-3);

    // HISTORIE bevat beide statussen, correct onderscheiden, en de volgende
    // fysieke telling vergelijkt nog altijd met de vorige ECHTE fysieke telling.
    const historyEntries = await repository.getStockHistoryEntries("office-1");
    const q1History = historyEntries
      .filter((e) => e.articleId === "office-1:Q1")
      .sort((a, b) => a.countDate.localeCompare(b.countDate));
    expect(q1History.map((e) => `${e.sessionName}:${e.status}`)).toEqual([
      "2026-08 Volledig:OVERGENOMEN - NIET GETELD",
      "2026-Q3 Kwartaal:GETELD",
    ]);
    const septHistoryEntry = q1History.find((e) => e.sessionName === "2026-Q3 Kwartaal")!;
    expect(septHistoryEntry.previousCount).toBe(12);
    expect(septHistoryEntry.differenceQuantity).toBe(-3);
  });
});
