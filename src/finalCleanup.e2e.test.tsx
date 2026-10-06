// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { db } from "./adapters/storage/db";
import {
  comparisonService,
  countSessionService,
  countingRepository,
  exportService,
  locationAssignmentService,
} from "./application/container";
import { makeEntry, makeFile } from "./application/services/centralHistoryTestUtils";
import { makeMaster } from "./application/services/centralMasterTestUtils";
import { legacySessionName } from "./domain/legacyImport";
import { REQUIRED_LEGACY_PERIODS } from "./domain/legacyPeriods";
import { ArticlesPage } from "./ui/pages/ArticlesPage";
import { SettingsPage } from "./ui/pages/SettingsPage";

/**
 * Finale acceptatie: lege browser → kantoorindex → Lokeren/Damme kiezen → master + historiek
 * → Home toont alle vorige tellingen (app + legacy) — zonder toegangscode, zonder Excel.
 */
const OFFICES = [
  { id: "lokeren", name: "Lokeren" },
  { id: "damme", name: "Damme" },
];

function historyFor(officeId: string) {
  const entries = [
    makeEntry({ articleId: `${officeId}:A1`, articleNumber: "A1", countDate: "2026-10-06", sessionType: "QUARTERLY", sessionName: "2026-Q3 Kwartaal", sourceSessionId: `${officeId}-q3`, totalCount: 12, costPrice: 2.5, status: "GETELD" }),
    makeEntry({ articleId: `${officeId}:A2`, articleNumber: "A2", countDate: "2026-10-06", sessionType: "QUARTERLY", sessionName: "2026-Q3 Kwartaal", sourceSessionId: `${officeId}-q3`, totalCount: 3, costPrice: 2.5, status: "GETELD" }),
  ];
  REQUIRED_LEGACY_PERIODS.forEach((period, i) => {
    for (const art of ["A1", "A2"]) {
      entries.push(
        makeEntry({ articleId: `${officeId}:${art}`, articleNumber: art, countDate: period.isoDate, sessionType: "FULL", sessionName: legacySessionName(period.label), sourceSessionId: undefined, totalCount: 10 + i, previousCount: null, differenceQuantity: null, costPrice: 7 + i, differenceAmount: null, status: "LEGACY", locationNames: [], source: "LEGACY_IMPORT" }),
      );
    }
  });
  return makeFile(entries, { officeId });
}

let online = true;
function stubNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (!online) throw new TypeError("Failed to fetch");
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/central-master") {
        return json({
          schemaVersion: 1,
          offices: OFFICES.map((o) => ({ ...o, revision: `rev-${o.id}`, generatedAt: "2026-10-06T12:00:00.000Z", articleCount: 2 })),
        });
      }
      const office = OFFICES.find((o) => url.includes(`officeId=${o.id}`));
      if (!office) return json({ error: "onbekend" }, 404);
      if (url.startsWith("/api/central-master")) {
        return json(makeMaster({ officeId: office.id, office: { name: office.name, baseDate: null }, revision: `rev-${office.id}` }));
      }
      if (url.startsWith("/api/central-history")) return json(historyFor(office.id));
      return json({ error: "onbekend" }, 404);
    }),
  );
}

beforeEach(async () => {
  online = true;
  await Promise.all(db.tables.map((t) => t.clear()));
  window.sessionStorage.clear();
  stubNetwork();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(OFFICES)("lege browser → $name zonder import", ({ id, name }) => {
  it("kantoor kiezen haalt master + historiek op; Home toont alle vorige tellingen (1 app + 7 legacy)", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Kies je kantoor" })).toBeInTheDocument();
    // Beide kantoren zijn beschikbaar, geen code-/login-veld, Excel enkel onder 'Geavanceerd'.
    expect(screen.getByRole("button", { name: "Lokeren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Damme" })).toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector("details.advanced-settings")?.textContent).toMatch(/Excelbestand/);

    await user.click(screen.getByRole("button", { name }));
    expect(await screen.findByText("Vorige tellingen (8)")).toBeInTheDocument();
    expect(await countingRepository.getSelectedOfficeId()).toBe(id);
    expect((await countingRepository.getArticles(id)).length).toBeGreaterThanOrEqual(2);
    expect((await countingRepository.getOffice(id))?.locations.length).toBe(2);
    expect(await countingRepository.getSessionsForOffice(id)).toHaveLength(1);

    // Home is opgeschoond: de vier kernacties, geen "+ Ander kantoor toevoegen".
    for (const label of ["Nieuwe telling", "Artikels", "Instellingen"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Ander kantoor toevoegen/ })).toBeNull();
  });
});

describe("kantoor wisselen, offline verderwerken, exports en vergelijkingen", () => {
  it("de kantoorselector toont ook het nog niet geladen kantoor en haalt het automatisch op; daarna offline", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Lokeren" }));
    await screen.findByText("Vorige tellingen (8)");

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).map((o) => o.text)).toEqual(["Lokeren", "Damme"]));
    await user.selectOptions(select, "damme");
    await waitFor(async () => expect(await countingRepository.getOffice("damme")).toBeDefined());
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("damme"));
    expect(await screen.findByText("Vorige tellingen (8)")).toBeInTheDocument();

    // Offline: wisselen tussen de twee lokale kantoren blijft werken.
    online = false;
    await user.selectOptions(screen.getByRole("combobox"), "lokeren");
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("lokeren"));
    expect(await screen.findByText("Vorige tellingen (8)")).toBeInTheDocument();
  });

  it("offline: telling starten, hervatten en annuleren werkt volledig vanuit IndexedDB; app-export en vergelijkingen werken", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Lokeren" }));
    await screen.findByText("Vorige tellingen (8)");
    online = false;

    const session = await countSessionService.startSession("lokeren", "MONTHLY");
    expect((await countSessionService.getActiveSession("lokeren"))?.id).toBe(session.id);
    await countSessionService.cancelSession(session.id);
    expect(await countSessionService.getActiveSession("lokeren")).toBeUndefined();

    const [app] = (await countingRepository.getSessionsForOffice("lokeren")).filter((s) => s.status === "COMPLETED");
    const file = await exportService.exportSessionResults(app.id);
    expect(file.data.byteLength).toBeGreaterThan(1000);

    const ll = await comparisonService.compareSessions("lokeren", "legacy:2026-06-30", "legacy:2026-09-01");
    const la = await comparisonService.compareSessions("lokeren", "legacy:2026-09-01", app.id);
    expect(ll.articles.length).toBeGreaterThan(0);
    expect(la.articles.length).toBeGreaterThan(0);
  });
});

describe("Instellingen — opgeschoond", () => {
  async function bootstrap() {
    const user = userEvent.setup();
    const result = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Lokeren" }));
    await screen.findByText("Vorige tellingen (8)");
    result.unmount();
    return user;
  }

  it("normale weergave bevat geen legacy-import, sync-/IndexedDB-jargon of Tellingen-lijst; die staan onder 'Geavanceerd beheer'", async () => {
    await bootstrap();
    const { container } = render(<SettingsPage officeId="lokeren" onImportNewOffice={() => {}} />);
    await screen.findByText("Stocklocaties");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Naam wijzigen" })).toBeNull());
    const clone = container.cloneNode(true) as HTMLElement;
    const advanced = clone.querySelector("details.advanced-settings");
    expect(advanced).not.toBeNull();
    expect(advanced?.querySelector("summary")?.textContent).toBe("Geavanceerd beheer");
    expect(advanced?.textContent).toMatch(/Historische stockimport/);
    advanced?.remove();
    const visible = clone.textContent ?? "";
    expect(visible).not.toMatch(/legacy|import|sync|IndexedDB|migrat|centraal|alleen-lezen|\bTellingen\b/i);
    // Centrale locaties en gamma's: gewoon getoond, zonder bewerkknoppen.
    expect(visible).toContain("Magazijn");
    expect(visible).toContain("Kabels");
    expect(clone.querySelectorAll("button").length).toBe(0); // geen beheerknoppen voor centrale locaties/gamma's
  });

  it("productgamma's zonder artikels zijn verborgen in de normale weergave", async () => {
    await bootstrap();
    const { container } = render(<SettingsPage officeId="lokeren" />);
    await screen.findByText("Stocklocaties");
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelector("details.advanced-settings")?.remove();
    // Het gamma "Lampen" bevat A2; ongebruikte gamma's (0 artikels) staan niet in de lijst.
    const rows = Array.from(clone.querySelectorAll(".location-settings-row__name")).map((n) => n.textContent);
    expect(rows).toContain("Kabels");
    expect(clone.textContent).not.toMatch(/\b0 artikel/);
  });
});

describe("Artikels — locatiechips", () => {
  it("centraal aangeleverde koppelingen hebben geen ×; lokaal geleerde koppelingen blijven verwijderbaar", async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await user.click(await screen.findByRole("button", { name: "Lokeren" }));
    await screen.findByText("Vorige tellingen (8)");
    first.unmount();

    // A1 is centraal gekoppeld aan loc-1; leer lokaal ook loc-2.
    await locationAssignmentService.addLocation("lokeren", ["lokeren:A1"], "lokeren:loc-2");
    render(<ArticlesPage officeId="lokeren" onOpenArticle={() => {}} />);
    await screen.findByText(/Centraal artikel A1/);
    await waitFor(() => expect(screen.getAllByText("Bestelwagen").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Magazijn verwijderen van dit artikel" })).toBeNull());
    expect(await screen.findByRole("button", { name: "Bestelwagen verwijderen van dit artikel" })).toBeInTheDocument();
    // "+ Nieuw artikel" blijft beschikbaar (maar discreet).
    expect(screen.getByRole("button", { name: "+ Nieuw artikel" })).toHaveClass("chip");
  });
});
