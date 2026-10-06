// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { db } from "../../adapters/storage/db";
import { countingRepository } from "../../application/container";
import { CentralMasterSyncService } from "../../application/services/CentralMasterSyncService";
import { makeArticle } from "../../application/services/centralHistoryTestUtils";
import { FakeCentralMasterSource, makeMaster } from "../../application/services/centralMasterTestUtils";
import type { Article } from "../../domain/types";
import { ArticleDetailPage } from "./ArticleDetailPage";
import { ArticlesPage } from "./ArticlesPage";
import { SettingsPage } from "./SettingsPage";

/**
 * Read-only gedrag (beslissing B): centraal beheerde mastervelden, locaties en
 * productgamma's zijn read-only in de gewone app; lokale tellingen en tijdelijke
 * (TMP) uitzonderingsartikelen blijven bewerkbaar.
 */
const TMP_ID = "damme:TMP-DAM-0001";

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  const sync = new CentralMasterSyncService(countingRepository, new FakeCentralMasterSource(makeMaster()));
  await sync.syncOffice("damme", { force: true, selectOffice: true });
  const tmp: Article = {
    ...makeArticle("damme", "TMP-DAM-0001"),
    idType: "TIJDELIJK",
    description: "Veldartikel",
    categoryId: null,
  };
  await countingRepository.saveArticles([tmp]);
});

afterEach(() => cleanup());

describe("Instellingen — centraal beheerd kantoor", () => {
  it("locaties en productgamma's zijn alleen-lezen: geen toevoegvelden, geen hernoem-/verwijderknoppen", async () => {
    render(<SettingsPage officeId="damme" />);
    expect(await screen.findByText("Magazijn")).toBeInTheDocument();
    expect(await screen.findByText("Kabels")).toBeInTheDocument();
    // Geen technische uitleg meer in de normale weergave.
    expect(screen.queryByText(/centraal beheerd/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/alleen-lezen/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Naam wijzigen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Locatie toevoegen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Productgamma toevoegen/ })).not.toBeInTheDocument();
  });

  it("een kantoor zonder centrale master blijft volledig bewerkbaar (geen regressie)", async () => {
    await countingRepository.saveOffice({
      id: "lokeren",
      name: "Lokeren",
      baseDate: null,
      locations: [{ id: "lokeren:loc-1", officeId: "lokeren", number: 1, name: "Rek", active: true }],
      categoriesMigrated: true,
    });
    render(<SettingsPage officeId="lokeren" />);
    await screen.findByText("Rek");
    expect(screen.queryByText(/centraal beheerd/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Naam wijzigen" }).length).toBeGreaterThan(0);
  });
});

describe("Artikeldetail — centraal beheerd artikel", () => {
  it("een centraal artikel is alleen-lezen: geen 'Bewerken', geen technische melding", async () => {
    render(<ArticleDetailPage officeId="damme" articleId="damme:A1" />);
    expect(await screen.findByText("Artikelnummer")).toBeInTheDocument();
    expect(screen.queryByText("Centraal beheerd — alleen-lezen")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bewerken" })).not.toBeInTheDocument();
  });

  it("een lokaal TMP-artikel blijft bewerkbaar", async () => {
    const user = userEvent.setup();
    render(<ArticleDetailPage officeId="damme" articleId={TMP_ID} />);
    const edit = await screen.findByRole("button", { name: "Bewerken" });
    expect(screen.queryByText("Centraal beheerd — alleen-lezen")).not.toBeInTheDocument();
    await user.click(edit);
    expect(screen.getByDisplayValue("Veldartikel")).toBeInTheDocument();
  });
});

describe("Artikels — bulkacties", () => {
  it("bulk 'Productgamma wijzigen', 'Assortiment wijzigen' en 'Verplaatsen naar' zijn verborgen; 'Locatie toevoegen' blijft", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="damme" onOpenArticle={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument());
    await user.click(await screen.findByRole("checkbox", { name: "Selecteer alle gefilterde artikelen" }));
    const bar = (await screen.findByRole("button", { name: "Locatie toevoegen" })).parentElement as HTMLElement;
    expect(within(bar).queryByRole("button", { name: /Verplaatsen naar/ })).not.toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Productgamma wijzigen" })).not.toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Assortiment wijzigen" })).not.toBeInTheDocument();
  });
});
