// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { db } from "../../adapters/storage/db";
import { countSessionService, countingRepository } from "../../application/container";
import { getStockClassification } from "../../domain/stockClassification";
import { buildObsoleteAnalysis, toAnalysisArticleRow } from "../../domain/analysis";
import type { ArticleSnapshot } from "../../domain/stockSnapshot";
import { CentralMasterSyncService } from "../../application/services/CentralMasterSyncService";
import { makeArticle } from "../../application/services/centralHistoryTestUtils";
import { FakeCentralMasterSource, makeMaster, makeMasterArticle } from "../../application/services/centralMasterTestUtils";
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

  it("een centraal artikel: mastervelden read-only, maar Voorraadclassificatie blijft lokaal aanpasbaar (alleen dat veld)", async () => {
    const user = userEvent.setup();
    // Bevroren snapshot van vóór de wijziging.
    const session = await countSessionService.startSession("damme", "QUARTERLY");
    await countSessionService.completeSessionWithOutstandingArticles(session.id);
    const before = (await countingRepository.getFinalizedSessionResult(session.id))!;
    const frozenBefore = JSON.stringify(before.snapshot);
    const original = (await countingRepository.getArticles("damme")).find((a) => a.id === "damme:A1")!;

    render(<ArticleDetailPage officeId="damme" articleId="damme:A1" />);
    expect(await screen.findByText("Artikelnummer")).toBeInTheDocument();
    // Wacht tot de centrale status geladen is (dan verschijnt de beperkte actie).
    await screen.findByRole("button", { name: "Voorraadclassificatie aanpassen" });
    // Volledige bewerkmodus blijft verborgen.
    expect(screen.queryByRole("button", { name: "Bewerken" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(original.description)).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Voorraadclassificatie aanpassen" }));
    // Annuleren wijzigt niets.
    await user.selectOptions(screen.getByRole("combobox", { name: "Voorraadclassificatie" }), "OBSOLETE");
    await user.click(screen.getByRole("button", { name: "Annuleren" }));
    expect(getStockClassification((await countingRepository.getArticles("damme")).find((a) => a.id === "damme:A1")!)).toBe("ACTIVE");

    await user.click(screen.getByRole("button", { name: "Voorraadclassificatie aanpassen" }));
    expect(within(screen.getByRole("combobox", { name: "Voorraadclassificatie" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Normale voorraad",
      "Obsolete",
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Voorraadclassificatie" }), "OBSOLETE");
    await user.click(screen.getByRole("button", { name: "Opslaan" }));

    await waitFor(async () => {
      const saved = (await countingRepository.getArticles("damme")).find((a) => a.id === "damme:A1")!;
      expect(saved.stockClassification).toBe("OBSOLETE");
    });
    const saved = (await countingRepository.getArticles("damme")).find((a) => a.id === "damme:A1")!;
    // Enkel stockClassification is gewijzigd.
    expect(saved.stockClassificationManual).toBe(true); // handmatige keuze is leidend
    expect({ ...saved, stockClassification: original.stockClassification, stockClassificationManual: undefined }).toEqual({
      ...original,
      stockClassificationManual: undefined,
    });

    // Bestaande analyse/obsolete-logica gebruikt de classificatie.
    const row = toAnalysisArticleRow(
      { articleId: saved.id, article: saved, status: "GETELD", totalCount: 2, previousCount: null } as unknown as ArticleSnapshot,
      new Map(),
    );
    expect(row.classification).toBe("OBSOLETE");
    expect(buildObsoleteAnalysis([row], 100).articles).toHaveLength(1);

    // Historische snapshot blijft bevroren.
    const after = (await countingRepository.getFinalizedSessionResult(session.id))!;
    expect(JSON.stringify(after.snapshot)).toBe(frozenBefore);
  });

  it("een tijdelijk (TMP) artikel dat in de master staat is volledig bewerkbaar", async () => {
    const user = userEvent.setup();
    const sync = new CentralMasterSyncService(
      countingRepository,
      new FakeCentralMasterSource(
        makeMaster({
          revision: "rev-tmp",
          articles: [makeMasterArticle("TMP-DAM-0003", { idType: "TIJDELIJK", description: "3M Verbindingsmof" })],
          assignments: [],
        }),
      ),
    );
    await sync.syncOffice("damme", { force: true, selectOffice: true });
    render(<ArticleDetailPage officeId="damme" articleId="damme:TMP-DAM-0003" />);
    await user.click(await screen.findByRole("button", { name: "Bewerken" }));
    const input = screen.getByDisplayValue("3M Verbindingsmof");
    await user.clear(input);
    await user.type(input, "3M mof lokaal");
    await user.click(screen.getByRole("button", { name: /Opslaan/ }));
    await waitFor(async () => {
      const a = (await countingRepository.getArticles("damme")).find((x) => x.id === "damme:TMP-DAM-0003");
      expect(a?.description).toBe("3M mof lokaal");
    });
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
  it("bulk 'Productgamma wijzigen', 'Assortiment wijzigen', 'Verplaatsen naar' en 'Locatie verwijderen' zijn verborgen; 'Locatie toevoegen' blijft", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="damme" onOpenArticle={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument());
    await user.click(await screen.findByRole("checkbox", { name: "Selecteer alle gefilterde artikelen" }));
    const bar = (await screen.findByRole("button", { name: "Locatie toevoegen" })).parentElement as HTMLElement;
    expect(within(bar).queryByRole("button", { name: /Verplaatsen naar/ })).not.toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Locatie verwijderen" })).not.toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Productgamma wijzigen" })).not.toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Assortiment wijzigen" })).not.toBeInTheDocument();
  });
});
