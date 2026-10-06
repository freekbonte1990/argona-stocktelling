// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { db } from "./adapters/storage/db";
import { countingRepository } from "./application/container";
import { CentralMasterSyncService } from "./application/services/CentralMasterSyncService";
import { FakeCentralMasterSource, makeMaster } from "./application/services/centralMasterTestUtils";

/**
 * Eerste start: zonder enig lokaal kantoor opent de app het kantoor-kiesscherm
 * (niet de Excel-import, en zonder toegangscode). Excel blijft een bewuste fallback.
 */
beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  window.sessionStorage.clear();
  // Geen netwerk in deze tests: elke centrale aanvraag is "offline".
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App — eerste start", () => {
  it("een leeg toestel toont het kantoor-kiesscherm zonder enig toegangscode-/login-veld, met Excel als fallback", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Kies je kantoor" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: /Excelbestand importeren/ })).toBeInTheDocument();
  });

  it("'Liever een Excelbestand importeren' opent de bestaande Excel-import (fallback blijft werken)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Excelbestand importeren/ }));
    expect((await screen.findAllByText(/Excel/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Kies je kantoor" })).not.toBeInTheDocument();
  });

  it("een toestel met een kantoor opent gewoon Home — het bootstrap-scherm verschijnt niet opnieuw, ook offline", async () => {
    await new CentralMasterSyncService(countingRepository, new FakeCentralMasterSource(makeMaster())).syncOffice("damme", {
      force: true,
      selectOffice: true,
    });
    render(<App />);
    expect((await screen.findAllByText("Damme")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "Kies je kantoor" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ander kantoor toevoegen/ })).toBeInTheDocument();
  });
});
