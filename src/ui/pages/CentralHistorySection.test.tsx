// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { db } from "../../adapters/storage/db";
import { countingRepository } from "../../application/container";
import { makeEntry, makeFile, makeOffice } from "../../application/services/centralHistoryTestUtils";
import type { CentralHistoryStatus } from "../../domain/centralHistoryFile";
import type { CountSession } from "../../domain/types";
import { SettingsPage } from "./SettingsPage";

function completed(id: string, completedAt: string): CountSession {
  return {
    id,
    officeId: "damme",
    type: "MONTHLY",
    status: "COMPLETED",
    startedAt: completedAt,
    completedAt,
    sourceFileName: "x",
    sourceBaseDate: null,
    articleIds: [],
  };
}

const status: CentralHistoryStatus = {
  officeId: "damme",
  lastAttemptAt: "2026-10-02T08:00:00.000Z",
  lastSuccessAt: "2026-10-02T08:00:00.000Z",
  lastError: "Centrale historiek niet bereikbaar — de lokale data blijft beschikbaar.",
  lastGeneratedAt: "2026-10-01T12:00:00.000Z",
  lastAddedSessionCount: 1,
  centralSessionIds: ["central-aug"],
  centralSessionNames: ["2026-08 Maand"],
};

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  await countingRepository.saveOffice(makeOffice());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Instellingen → Centrale historiek", () => {
  it("toont enkel lezen: laatste succes, discrete waarschuwing, geen publiceeractie", async () => {
    await countingRepository.saveCentralHistoryStatus(status);
    render(<SettingsPage officeId="damme" />);
    expect(await screen.findByRole("heading", { name: "Centrale historiek" })).toBeInTheDocument();
    expect(await screen.findByText(/niet bereikbaar/)).toBeInTheDocument();
    expect(screen.getByText(/Laatst gesynchroniseerd/)).toBeInTheDocument();
    // Geen enkele knop om naar de centrale bron te publiceren/uploaden.
    expect(screen.queryByRole("button", { name: /publiceer|upload|verstuur/i })).not.toBeInTheDocument();
  });

  it("verbergt 'Verwijderen' voor een centrale telling en toont het voor een lokale telling", async () => {
    await countingRepository.saveCentralHistoryStatus(status);
    await countingRepository.createSession(completed("central-aug", "2026-08-31T10:00:00.000Z"));
    await countingRepository.createSession(completed("local-jul", "2026-07-31T10:00:00.000Z"));
    render(<SettingsPage officeId="damme" />);

    const centralRow = (await screen.findByText("2026-08 Maand")).closest(".location-settings-row") as HTMLElement;
    const localRow = (await screen.findByText("2026-07 Maand")).closest(".location-settings-row") as HTMLElement;
    expect(within(centralRow).queryByRole("button", { name: "Verwijderen" })).not.toBeInTheDocument();
    expect(within(centralRow).getByText(/alleen-lezen/)).toBeInTheDocument();
    expect(within(localRow).getByRole("button", { name: "Verwijderen" })).toBeInTheDocument();
  });

  it("code invoeren → opslaan → synchroniseert en voegt de centrale telling toe", async () => {
    const file = makeFile([makeEntry({ articleId: "damme:A1", articleNumber: "A1" })]);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(file), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<SettingsPage officeId="damme" />);

    await user.type(await screen.findByLabelText(/Toegangscode/), "een-geldige-toegangscode");
    await user.click(screen.getByRole("button", { name: /Opslaan en synchroniseren/ }));

    await waitFor(async () => expect(await countingRepository.getSession("session-aug")).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer een-geldige-toegangscode");
    expect(await screen.findByRole("button", { name: /Nu synchroniseren/ })).toBeInTheDocument();
    // De code zelf wordt nergens in de UI getoond.
    expect(screen.queryByText("een-geldige-toegangscode")).not.toBeInTheDocument();
  });

  it("zonder code of bij een mislukte sync blijft de pagina bruikbaar (geen crash)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await countingRepository.setCentralHistoryAccessCode("een-geldige-toegangscode");
    const user = userEvent.setup();
    render(<SettingsPage officeId="damme" />);
    await user.click(await screen.findByRole("button", { name: /Nu synchroniseren/ }));
    expect(await screen.findByText(/niet bereikbaar/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Instellingen" })).toBeInTheDocument();
  });
});
