import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountSessionService } from "../../application/services/CountSessionService";
import { CountingService } from "../../application/services/CountingService";
import { ExportService } from "../../application/services/ExportService";
import { InMemoryCountingRepository } from "../../application/services/InMemoryCountingRepository";
import type { Article, Office, CountSessionType } from "../../domain/types";
import { ExcelStockResultExporter } from "./ExcelStockResultExporter";

/**
 * Regressie: de naam van het benoemde tellingtabblad in de Excel-export is de
 * BEVROREN sessienaam (`FinalizedSessionResult.snapshot.sessionName`, vastgelegd
 * bij het afronden). Ze wordt nooit opnieuw afgeleid uit de exportdatum of de
 * huidige datum, ook niet bij herexport.
 */
const office: Office = {
  id: "office-1",
  name: "Lokeren",
  baseDate: "2026-01-01",
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
};

const article: Article = {
  id: "office-1:A1",
  officeId: "office-1",
  articleNumber: "A1",
  officialArticleNumber: "A1",
  idType: "OFFICIEEL",
  description: "Artikel",
  productGroup: "GROEP",
  supplier: null,
  unit: "stuk",
  costPrice: 1,
  rawCountPeriod: "MAAND",
  countPeriod: "MONTHLY",
  rawStatus: "ACTIEF",
  status: "ACTIVE",
  previousCount: 1,
  sourceRow: 1,
};

const NAMED = /(Maand|Kwartaal|Jaar|Volledig)( \(bevroren\))?$/;
const namedSheets = (data: ArrayBuffer) =>
  XLSX.read(data, { type: "array" }).SheetNames.filter((n) => NAMED.test(n));

describe("Excel-export: tabbladnaam = bevroren sessienaam", () => {
  let repository: InMemoryCountingRepository;
  let sessions: CountSessionService;
  let counting: CountingService;
  let exportService: ExportService;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    repository = new InMemoryCountingRepository();
    sessions = new CountSessionService(repository);
    counting = new CountingService(repository);
    exportService = new ExportService(repository, new ExcelStockResultExporter());
    await repository.saveOffice(office);
    await repository.saveArticles([article]);
  });
  afterEach(() => vi.useRealTimers());

  async function completeOn(date: Date, type: CountSessionType) {
    vi.setSystemTime(date);
    const session = await sessions.startSession("office-1", type);
    await counting.recordCount({ session, articleId: article.id, locationId: "office-1:loc-1", quantity: 3 });
    await counting.completeLocation(session.id, "office-1:loc-1");
    await sessions.completeSession(session.id);
    return session;
  }

  it("kwartaaltelling afgerond op 06/10/2026 → tabblad blijft '2026-Q3 Kwartaal'", async () => {
    const session = await completeOn(new Date(2026, 9, 6, 10), "QUARTERLY");
    const exported = await exportService.exportSessionResults(session.id);
    expect(namedSheets(exported.data)).toEqual(["2026-Q3 Kwartaal"]);
  });

  it("herexport (ook ná de coulanceperiode / in een nieuw kwartaal) behoudt dezelfde naam, zonder extra tabblad", async () => {
    const session = await completeOn(new Date(2026, 9, 6, 10), "QUARTERLY");
    const first = await exportService.exportSessionResults(session.id);

    for (const later of [new Date(2026, 9, 6, 23), new Date(2026, 9, 20, 9), new Date(2027, 0, 5, 9)]) {
      vi.setSystemTime(later);
      const again = await exportService.exportSessionResults(session.id);
      expect(namedSheets(again.data)).toEqual(namedSheets(first.data));
      expect(namedSheets(again.data)).toEqual(["2026-Q3 Kwartaal"]);
    }
  });

  it("maandtelling: de bevroren sessienaam is de bron van waarheid (06/10 → '2026-09 Maand', stabiel bij herexport)", async () => {
    const session = await completeOn(new Date(2026, 9, 6, 10), "MONTHLY");
    const first = await exportService.exportSessionResults(session.id);
    expect(namedSheets(first.data)).toEqual(["2026-09 Maand"]);

    vi.setSystemTime(new Date(2026, 10, 25, 9));
    const again = await exportService.exportSessionResults(session.id);
    expect(namedSheets(again.data)).toEqual(["2026-09 Maand"]);
  });

  it("de export gebruikt de bevroren naam uit het afrondingsresultaat, niet een herafleiding uit completedAt/exportdatum", async () => {
    const session = await completeOn(new Date(2026, 9, 6, 10), "QUARTERLY");
    const finalized = await repository.getFinalizedSessionResult(session.id);
    expect(finalized?.snapshot.sessionName).toBe("2026-Q3 Kwartaal");

    // Bevroren naam wijkt bewust af van wat de afleidingsregel zou geven:
    // de export moet de bevroren naam volgen.
    const frozen = { ...finalized!, snapshot: { ...finalized!.snapshot, sessionName: "2026-Q3 Kwartaal (bevroren)" } };
    vi.spyOn(repository, "getFinalizedSessionResult").mockResolvedValue(frozen);
    vi.setSystemTime(new Date(2027, 5, 1, 9));
    const exported = await exportService.exportSessionResults(session.id);
    expect(namedSheets(exported.data)).toEqual(["2026-Q3 Kwartaal (bevroren)"]);
  });
});
