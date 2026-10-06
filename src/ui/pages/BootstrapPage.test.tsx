// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { db } from "../../adapters/storage/db";
import { countingRepository } from "../../application/container";
import { makeEntry, makeFile } from "../../application/services/centralHistoryTestUtils";
import { makeMaster } from "../../application/services/centralMasterTestUtils";
import { BootstrapPage } from "./BootstrapPage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const index = {
  schemaVersion: 1,
  offices: [
    { id: "damme", name: "Damme", revision: "rev-0001", generatedAt: "2026-10-01T12:00:00.000Z", articleCount: 2 },
    { id: "lokeren", name: "Lokeren", revision: "rev-lok-1", generatedAt: "2026-10-01T12:00:00.000Z", articleCount: 0 },
  ],
};

interface Net {
  online: boolean;
  requests: Array<{ url: string; headers: Record<string, string> }>;
}

function stubNetwork(net: Net) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      net.requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (!net.online) throw new TypeError("Failed to fetch");
      if (url === "/api/central-master") return json(index);
      if (url.startsWith("/api/central-master?officeId=damme")) return json(makeMaster());
      if (url.startsWith("/api/central-history?officeId=damme")) {
        return json(makeFile([makeEntry({ articleId: "damme:A1", articleNumber: "A1", totalCount: 8 })]));
      }
      return json({ error: "onbekend" }, 404);
    }),
  );
}

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BootstrapPage — eerste start op een nieuw toestel (zonder toegangscode)", () => {
  it("toont meteen de kantoren (geen code, login of auth-scherm), haalt master + historiek op en meldt zich klaar", async () => {
    const net: Net = { online: true, requests: [] };
    stubNetwork(net);
    const onBootstrapped = vi.fn();
    const user = userEvent.setup();
    render(<BootstrapPage onBootstrapped={onBootstrapped} onUseExcel={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Kies je kantoor" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/toegangscode|wachtwoord|code/i)).not.toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Damme" }));
    await waitFor(() => expect(onBootstrapped).toHaveBeenCalledWith("damme"));

    expect((await countingRepository.getArticles("damme")).length).toBe(2);
    expect(await countingRepository.getSelectedOfficeId()).toBe("damme");
    expect(await countingRepository.getSessionsForOffice("damme")).toHaveLength(1);
    // Geen enkele aanvraag draagt een Authorization-header:
    expect(net.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of net.requests) {
      expect(Object.keys(request.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
  });

  it("offline: een foutmelding met 'Opnieuw proberen' — en niets lokaal opgeslagen", async () => {
    const net: Net = { online: false, requests: [] };
    stubNetwork(net);
    const user = userEvent.setup();
    render(<BootstrapPage onBootstrapped={() => {}} onUseExcel={() => {}} />);
    expect(await screen.findByText(/niet bereikbaar/)).toBeInTheDocument();
    expect(screen.queryByText(/code|geweigerd|geautoriseerd|login/i)).not.toBeInTheDocument();
    net.online = true;
    await user.click(screen.getByRole("button", { name: "Opnieuw proberen" }));
    expect(await screen.findByRole("button", { name: "Damme" })).toBeInTheDocument();
    expect(await countingRepository.getAllOffices()).toEqual([]);
  });

  it("een HTTP 401/403 van de host wordt als 'niet bereikbaar' getoond — nooit als auth-melding", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "nee" }, 401)));
    render(<BootstrapPage onBootstrapped={() => {}} onUseExcel={() => {}} />);
    expect(await screen.findByText(/niet (bereikbaar|beschikbaar)/)).toBeInTheDocument();
    expect(screen.queryByText(/toegangscode|geweigerd|geautoriseerd/i)).not.toBeInTheDocument();
  });

  it("een mislukte kantoor-keuze toont de fout, laat de kantoren staan en slaat niets op", async () => {
    stubNetwork({ online: true, requests: [] });
    const onBootstrapped = vi.fn();
    const user = userEvent.setup();
    render(<BootstrapPage onBootstrapped={onBootstrapped} onUseExcel={() => {}} />);
    // Lokeren staat in de lijst maar de master ontbreekt (404):
    await user.click(await screen.findByRole("button", { name: "Lokeren" }));
    expect(await screen.findByText(/nog geen centrale masterdata/)).toBeInTheDocument();
    expect(onBootstrapped).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Damme" })).toBeInTheDocument();
    expect(await countingRepository.getAllOffices()).toEqual([]);
  });

  it("Excel blijft als bewuste fallback beschikbaar; 'Annuleren' enkel vanaf het tweede kantoor", async () => {
    stubNetwork({ online: true, requests: [] });
    const onUseExcel = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<BootstrapPage onBootstrapped={() => {}} onUseExcel={onUseExcel} />);
    await screen.findByRole("button", { name: "Damme" });
    expect(screen.queryByRole("button", { name: "Annuleren" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Excelbestand importeren/ }));
    expect(onUseExcel).toHaveBeenCalledTimes(1);

    rerender(<BootstrapPage onBootstrapped={() => {}} onUseExcel={onUseExcel} onCancel={onCancel} />);
    await user.click(await screen.findByRole("button", { name: "Annuleren" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("markeert een kantoor dat al op dit toestel staat", async () => {
    await countingRepository.saveOffice({ id: "damme", name: "Damme", baseDate: null, locations: [] });
    stubNetwork({ online: true, requests: [] });
    render(<BootstrapPage onBootstrapped={() => {}} onUseExcel={() => {}} />);
    expect(await screen.findByRole("button", { name: /Damme \(al op dit toestel/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lokeren" })).toBeInTheDocument();
  });
});
