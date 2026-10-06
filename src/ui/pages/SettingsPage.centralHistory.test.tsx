// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "../../adapters/storage/db";
import { countingRepository } from "../../application/container";
import { makeOffice } from "../../application/services/centralHistoryTestUtils";
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

describe("Instellingen en centrale historiek", () => {
  it("toont geen technische sync-configuratie aan gewone gebruikers", async () => {
    await countingRepository.saveCentralHistoryStatus(status);
    render(<SettingsPage officeId="damme" />);
    expect(await screen.findByRole("heading", { name: "Instellingen" })).toBeInTheDocument();
    // Geen sectie, toegangscodeveld, sync-knop of laatste-sync-kaart.
    expect(screen.queryByRole("heading", { name: /Centrale historiek/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Toegangscode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /synchroniseren|toegangscode/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Laatst gesynchroniseerd/)).not.toBeInTheDocument();
    expect(screen.queryByText(/niet bereikbaar/)).not.toBeInTheDocument();
    // De interne status blijft wel bewaard voor debugging.
    expect((await countingRepository.getCentralHistoryStatus("damme"))?.lastError).toMatch(/niet bereikbaar/);
  });

  it("verbergt 'Verwijderen' voor een centrale telling en toont het voor een lokale telling", async () => {
    await countingRepository.saveCentralHistoryStatus(status);
    await countingRepository.createSession(completed("central-aug", "2026-08-31T10:00:00.000Z"));
    await countingRepository.createSession(completed("local-jul", "2026-07-31T10:00:00.000Z"));
    render(<SettingsPage officeId="damme" />);

    // De lijst staat onder "Geavanceerd beheer" en toont enkel lokale tellingen — een centrale telling is niet verwijderbaar en staat er niet.
    const localRow = (await screen.findByText("2026-07 Maand")).closest(".location-settings-row") as HTMLElement;
    await waitFor(() => expect(screen.queryByText("2026-08 Maand")).not.toBeInTheDocument());
    expect(screen.queryByText(/alleen-lezen/)).not.toBeInTheDocument();
    expect(within(localRow).getByRole("button", { name: "Verwijderen" })).toBeInTheDocument();
  });
});
