// @vitest-environment jsdom
import "fake-indexeddb/auto";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { db } from "./adapters/storage/db";
import {
  centralDataSyncService,
  comparisonService,
  countingRepository,
  legacySnapshotService,
} from "./application/container";
import { makeEntry, makeFile } from "./application/services/centralHistoryTestUtils";
import { makeMaster } from "./application/services/centralMasterTestUtils";
import { REQUIRED_LEGACY_PERIODS } from "./domain/legacyPeriods";
import { legacySessionName } from "./domain/legacyImport";
import { listLegacySnapshotItems } from "./domain/legacySnapshotView";
import { HomePage } from "./ui/pages/HomePage";
import { LegacySnapshotPage } from "./ui/pages/LegacySnapshotPage";

/**
 * Regressie: lege repo → centrale master → centrale historiek (1 echte app-telling
 * + 7 legacy periodes) → Home "Vorige tellingen (8)" → legacy detail (read-only)
 * → export met bevroren historische hoeveelheid + kostprijs → Vergelijken.
 */

const OFFICE = "lokeren";
const LIVE_COST = 2.5; // kostprijs in de centrale master (de ACTUELE kostprijs)

/** Historische hoeveelheid/kostprijs per legacy periode — bewust ≠ de actuele kostprijs. */
const legacyQty = (i: number, article: "A1" | "A2") => (article === "A1" ? 10 + i : 100 + i);
const legacyCost = (i: number, article: "A1" | "A2") => (article === "A1" ? 7 + i : 40 + i);

function buildHistory() {
  const entries = [
    makeEntry({
      articleId: `${OFFICE}:A1`,
      articleNumber: "A1",
      countDate: "2026-10-06",
      sessionType: "QUARTERLY",
      sessionName: "2026-Q3 Kwartaal",
      sourceSessionId: "session-q3",
      totalCount: 12,
      costPrice: 2.5,
      status: "GETELD",
    }),
    makeEntry({
      articleId: `${OFFICE}:A2`,
      articleNumber: "A2",
      countDate: "2026-10-06",
      sessionType: "QUARTERLY",
      sessionName: "2026-Q3 Kwartaal",
      sourceSessionId: "session-q3",
      totalCount: 3,
      costPrice: 2.5,
      status: "GETELD",
    }),
  ];
  REQUIRED_LEGACY_PERIODS.forEach((period, i) => {
    for (const art of ["A1", "A2"] as const) {
      entries.push(
        makeEntry({
          articleId: `${OFFICE}:${art}`,
          articleNumber: art,
          description: `Historisch ${art}`,
          countDate: period.isoDate,
          sessionType: "FULL",
          sessionName: legacySessionName(period.label),
          sourceSessionId: undefined,
          totalCount: legacyQty(i, art),
          previousCount: null,
          differenceQuantity: null,
          costPrice: legacyCost(i, art),
          differenceAmount: null,
          status: "LEGACY",
          locationNames: [],
          source: "LEGACY_IMPORT",
        }),
      );
    }
  });
  return makeFile(entries, { officeId: OFFICE });
}

function stubNetwork() {
  const master = makeMaster({ officeId: OFFICE, office: { name: "Lokeren", baseDate: null } });
  const history = buildHistory();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/central-master") ? master : url.startsWith("/api/central-history") ? history : null;
      return new Response(JSON.stringify(body), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
    }),
  );
}

async function readSheets(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  stubNetwork();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("legacy snapshots als 'Vorige tellingen' (lege repo → master → historiek)", () => {
  it("modelleert legacy NIET als sessie: 1 COMPLETED sessie + 7 presentatie-items", async () => {
    const result = await centralDataSyncService.bootstrapOffice(OFFICE);
    expect(result.ok).toBe(true);
    const sessions = await countingRepository.getSessionsForOffice(OFFICE);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: "COMPLETED", officeId: OFFICE });
    expect(await countingRepository.getFinalizedSessionResult(sessions[0].id)).toBeDefined();
    const items = listLegacySnapshotItems(await countingRepository.getStockHistoryEntries(OFFICE));
    expect(items).toHaveLength(7);
  });

  it("Home toont 'Vorige tellingen (8)', nieuwste eerst, legacy herkenbaar als Historische snapshot", async () => {
    await centralDataSyncService.bootstrapOffice(OFFICE);
    render(
      <HomePage
        officeId={OFFICE}
        onStartNewSession={() => {}}
        onResumeSession={() => {}}
        onOpenArticles={() => {}}
        onOpenSettings={() => {}}
        onSwitchOffice={() => {}}
        onImportNewOffice={() => {}}
        onOpenReview={() => {}}
        onOpenLegacySnapshot={() => {}}
        onCancelSession={async () => {}}
      />,
    );
    expect(await screen.findByText("Vorige tellingen (8)")).toBeInTheDocument();
    const rows = Array.from(document.querySelectorAll(".session-history-item")).map((el) => el.textContent ?? "");
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain("2026-Q3 Kwartaal");
    expect(rows[0]).not.toContain("Historische snapshot");
    const expectedLegacy = [...REQUIRED_LEGACY_PERIODS].reverse().map((p) => p.label);
    expectedLegacy.forEach((label, i) => {
      expect(rows[i + 1]).toContain(`${label} — Historische snapshot`);
    });
    expect(expectedLegacy[0]).toBe("01/09/2026");
    expect(expectedLegacy[6]).toBe("31/03/2025");
  });

  it("klik op een legacy item geeft het snapshot-id door; het detail is read-only en toont de kerncijfers", async () => {
    await centralDataSyncService.bootstrapOffice(OFFICE);
    const onOpenLegacy = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <HomePage
        officeId={OFFICE}
        onStartNewSession={() => {}}
        onResumeSession={() => {}}
        onOpenArticles={() => {}}
        onOpenSettings={() => {}}
        onSwitchOffice={() => {}}
        onImportNewOffice={() => {}}
        onOpenReview={() => {}}
        onOpenLegacySnapshot={onOpenLegacy}
        onCancelSession={async () => {}}
      />,
    );
    await screen.findByText("Vorige tellingen (8)");
    await user.click(screen.getByRole("button", { name: /01\/09\/2026 — Historische snapshot/ }));
    expect(onOpenLegacy).toHaveBeenCalledWith("legacy:2026-09-01");
    unmount();

    const onCompare = vi.fn();
    render(<LegacySnapshotPage officeId={OFFICE} snapshotId="legacy:2026-09-01" onOpenComparison={onCompare} />);
    expect(await screen.findByText("01/09/2026 — Historische snapshot")).toBeInTheDocument();
    expect(screen.getByText("Alleen-lezen")).toBeInTheDocument();
    expect(screen.getByText(/Lokeren/)).toBeInTheDocument();
    // Totale voorraadwaarde = Σ historische hoeveelheid × historische kostprijs (periode index 6).
    const expected = legacyQty(6, "A1") * legacyCost(6, "A1") + legacyQty(6, "A2") * legacyCost(6, "A2");
    expect(screen.getByText("Totale voorraadwaarde").previousSibling?.textContent).toContain(
      expected.toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
    expect(screen.getByText("Artikels", { selector: ".summary-tile__label" }).previousSibling?.textContent).toBe("2");
    expect(screen.getByText("Productgamma's", { selector: ".summary-tile__label" }).previousSibling?.textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Exporteren naar Excel" })).toBeInTheDocument();
    // Read-only: enkel het zoekveld, geen tel-/bewerkacties.
    expect(document.querySelectorAll("input")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /tellen|afronden|bewerken|opslaan/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Vergelijken" }));
    expect(onCompare).toHaveBeenCalledWith("legacy:2026-09-01");
    // Er is nog steeds geen sessie bijgekomen.
    expect(await countingRepository.getSessionsForOffice(OFFICE)).toHaveLength(1);
  });

  it("export gebruikt bevroren historische hoeveelheid + kostprijs; een wijziging van de actuele kostprijs lekt niet door", async () => {
    await centralDataSyncService.bootstrapOffice(OFFICE);
    const readExport = async () => {
      const file = await legacySnapshotService.exportToExcel(OFFICE, "legacy:2025-06-30");
      const wb = await readSheets(file.data);
      const sheet = wb.worksheets[1];
      const rows = new Map<string, { qty: unknown; cost: unknown; value: unknown }>();
      sheet.eachRow((row, n) => {
        if (n === 1) return;
        rows.set(String(row.getCell(1).value), { qty: row.getCell(4).value, cost: row.getCell(5).value, value: row.getCell(6).value });
      });
      const info = wb.getWorksheet("INFO")!;
      return { file, rows, infoText: JSON.stringify(info.getSheetValues()), sheetName: sheet.name };
    };

    const before = await readExport();
    const i = REQUIRED_LEGACY_PERIODS.findIndex((p) => p.key === "2025-06-30");
    expect(before.rows.get("A1")).toEqual({ qty: legacyQty(i, "A1"), cost: legacyCost(i, "A1"), value: legacyQty(i, "A1") * legacyCost(i, "A1") });
    expect(before.rows.get("A2")).toEqual({ qty: legacyQty(i, "A2"), cost: legacyCost(i, "A2"), value: legacyQty(i, "A2") * legacyCost(i, "A2") });
    expect(before.sheetName).toBe("Snapshot 30-06-2025");
    expect(before.infoText).toContain("Historische snapshot");
    expect(before.infoText).toContain("30/06/2025");
    expect(before.file.fileName).toContain("2025-06-30");

    // De actuele kostprijs wijzigt (en wijkt sowieso al af van de historische).
    const articles = await countingRepository.getArticles(OFFICE);
    expect(articles.every((a) => a.costPrice === LIVE_COST)).toBe(true);
    await countingRepository.saveArticles(articles.map((a) => ({ ...a, costPrice: 999 })));
    const after = await readExport();
    expect(after.rows).toEqual(before.rows);
    expect(JSON.stringify([...after.rows.values()])).not.toContain("999");
    // Legacy data zelf is onaangeroerd.
    const legacyEntries = (await countingRepository.getStockHistoryEntries(OFFICE)).filter((e) => e.source === "LEGACY_IMPORT");
    expect(legacyEntries).toHaveLength(14);
    expect(legacyEntries.find((e) => e.articleNumber === "A1" && e.countDate === "2025-06-30")?.costPrice).toBe(legacyCost(i, "A1"));
  });

  it("Vergelijken blijft werken: legacy↔legacy en legacy↔app (historische waarden aan de legacy-kant)", async () => {
    await centralDataSyncService.bootstrapOffice(OFFICE);
    const [app] = await countingRepository.getSessionsForOffice(OFFICE);
    const options = (await comparisonService.getComparisonOptions(OFFICE)).sessions;
    expect(options).toHaveLength(8);
    expect(options[0].sessionId).toBe(app.id);

    const legacyLegacy = await comparisonService.compareSessions(OFFICE, "legacy:2026-06-30", "legacy:2026-09-01");
    expect(legacyLegacy.headerA.provenance).toBe("LEGACY_IMPORT");
    expect(legacyLegacy.headerB.provenance).toBe("LEGACY_IMPORT");
    const ll = legacyLegacy.articles.find((r) => r.articleNumber === "A1")!;
    expect(ll.quantityA).toBe(legacyQty(5, "A1"));
    expect(ll.quantityB).toBe(legacyQty(6, "A1"));
    expect(ll.costPriceA).toBe(legacyCost(5, "A1"));
    expect(ll.costPriceB).toBe(legacyCost(6, "A1"));

    const legacyApp = await comparisonService.compareSessions(OFFICE, "legacy:2026-09-01", app.id);
    expect(legacyApp.headerA.provenance).toBe("LEGACY_IMPORT");
    expect(legacyApp.headerB.provenance).toBe("APP_COUNT");
    const la = legacyApp.articles.find((r) => r.articleNumber === "A1")!;
    expect(la.quantityA).toBe(legacyQty(6, "A1"));
    expect(la.costPriceA).toBe(legacyCost(6, "A1"));
    expect(la.quantityB).toBe(12);
  });

  it("Vergelijken blijft werken: app↔app (twee echte, centraal ingeladen sessies)", async () => {
    const history = buildHistory();
    history.entries.push(
      makeEntry({
        articleId: `${OFFICE}:A1`,
        articleNumber: "A1",
        countDate: "2026-09-30",
        sessionType: "MONTHLY",
        sessionName: "2026-09 Maand",
        sourceSessionId: "session-sep",
        totalCount: 9,
        costPrice: 2.5,
        status: "GETELD",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith("/api/central-master")
          ? makeMaster({ officeId: OFFICE, office: { name: "Lokeren", baseDate: null } })
          : history;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await centralDataSyncService.bootstrapOffice(OFFICE);
    const sessions = await countingRepository.getSessionsForOffice(OFFICE);
    expect(sessions).toHaveLength(2);
    const sep = sessions.find((x) => x.id === "session-sep")!;
    const q3 = sessions.find((x) => x.id === "session-q3")!;
    const result = await comparisonService.compareSessions(OFFICE, sep.id, q3.id);
    expect(result.headerA.provenance).toBe("APP_COUNT");
    const row = result.articles.find((r) => r.articleNumber === "A1")!;
    expect(row.quantityA).toBe(9);
    expect(row.quantityB).toBe(12);
  });
});

describe("LegacySnapshotPage export-knop", () => {
  it("downloadt een .xlsx zonder foutmelding", async () => {
    await centralDataSyncService.bootstrapOffice(OFFICE);
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const user = userEvent.setup();
    render(<LegacySnapshotPage officeId={OFFICE} snapshotId="legacy:2026-06-30" onOpenComparison={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Exporteren naar Excel" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".error-banner")).toBeNull();
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.size).toBeGreaterThan(1000);
  });
});
