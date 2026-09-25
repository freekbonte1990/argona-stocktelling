// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArticleDetailPage } from "./ArticleDetailPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, Office } from "../../domain/types";

/**
 * Aanvulling ("Bij Artikel moeten er gemakkelijk wijzigingen aangebracht
 * kunnen worden aan: omschrijving, productgroep, leverancier, en de prijs
 * moet ook zichtbaar zijn"): dekt de nieuwe inline-bewerkmodus op de
 * "Algemeen"-kaart met de echte IndexedDB-laag (fake-indexeddb).
 */

const office: Office = {
  id: "office-1",
  name: "Antwerpen",
  baseDate: null,
  locations: [],
};

const article: Article = {
  id: "office-1:A1",
  officeId: "office-1",
  articleNumber: "A1",
  officialArticleNumber: "A1",
  idType: "OFFICIEEL",
  description: "Oude omschrijving",
  productGroup: "OUDE GROEP",
  supplier: "Oude leverancier",
  unit: "stuk",
  costPrice: 12.5,
  rawCountPeriod: "MAAND",
  countPeriod: "MONTHLY",
  rawStatus: "ACTIEF",
  status: "ACTIVE",
  previousCount: 3,
  sourceRow: 1,
};

beforeEach(async () => {
  for (const table of [
    db.offices,
    db.articles,
    db.sessions,
    db.countEntries,
    db.assignments,
    db.appState,
    db.locationSessionStatuses,
    db.finalizedSessionResults,
  ]) {
    await table.clear();
  }
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([article]);
});

async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
  });
}

/** Scopet queries tot de "Algemeen"-kaart — de paginatitel (h1) toont ook de omschrijving. */
function algemeenCard(): HTMLElement {
  return screen.getByText("Algemeen").closest(".card") as HTMLElement;
}

describe("ArticleDetailPage — bewerken van Algemeen (aanvulling)", () => {
  it("toont de kostprijs (voorheen nergens zichtbaar) in de leesweergave", async () => {
    render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
    await waitUntilLoaded();

    expect(screen.getByText("€ 12,50")).toBeInTheDocument();
  });

  it("laat omschrijving/productgroep/leverancier/kostprijs bewerken en bewaart dat in de repository", async () => {
    const user = userEvent.setup();
    render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "Bewerken" }));

    const descriptionInput = screen.getByDisplayValue("Oude omschrijving");
    await user.clear(descriptionInput);
    await user.type(descriptionInput, "Nieuwe omschrijving");

    const productGroupInput = screen.getByDisplayValue("OUDE GROEP");
    await user.clear(productGroupInput);
    await user.type(productGroupInput, "NIEUWE GROEP");

    const supplierInput = screen.getByDisplayValue("Oude leverancier");
    await user.clear(supplierInput);
    await user.type(supplierInput, "Nieuwe leverancier");

    const costPriceInput = screen.getByDisplayValue("12.5");
    await user.clear(costPriceInput);
    await user.type(costPriceInput, "15,75");

    await user.click(screen.getByRole("button", { name: "Opslaan" }));

    await waitFor(() => {
      expect(within(algemeenCard()).getByText("Nieuwe omschrijving")).toBeInTheDocument();
    });
    expect(within(algemeenCard()).getByText("NIEUWE GROEP")).toBeInTheDocument();
    expect(within(algemeenCard()).getByText("Nieuwe leverancier")).toBeInTheDocument();
    expect(within(algemeenCard()).getByText("€ 15,75")).toBeInTheDocument();

    const [saved] = await countingRepository.getArticles("office-1");
    expect(saved.description).toBe("Nieuwe omschrijving");
    expect(saved.productGroup).toBe("NIEUWE GROEP");
    expect(saved.supplier).toBe("Nieuwe leverancier");
    expect(saved.costPrice).toBe(15.75);
    // Ongemoeide velden blijven exact zoals voorheen.
    expect(saved.previousCount).toBe(3);
    expect(saved.articleNumber).toBe("A1");
  });

  it("annuleren verwerpt de aanpassingen zonder iets op te slaan", async () => {
    const user = userEvent.setup();
    render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "Bewerken" }));
    const descriptionInput = screen.getByDisplayValue("Oude omschrijving");
    await user.clear(descriptionInput);
    await user.type(descriptionInput, "Verworpen wijziging");
    await user.click(screen.getByRole("button", { name: "Annuleren" }));

    expect(within(algemeenCard()).getByText("Oude omschrijving")).toBeInTheDocument();
    const [saved] = await countingRepository.getArticles("office-1");
    expect(saved.description).toBe("Oude omschrijving");
  });

  it("weigert een lege omschrijving op te slaan", async () => {
    const user = userEvent.setup();
    render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "Bewerken" }));
    const descriptionInput = screen.getByDisplayValue("Oude omschrijving");
    await user.clear(descriptionInput);
    await user.click(screen.getByRole("button", { name: "Opslaan" }));

    expect(await screen.findByText("Omschrijving mag niet leeg zijn.")).toBeInTheDocument();
    const [saved] = await countingRepository.getArticles("office-1");
    expect(saved.description).toBe("Oude omschrijving");
  });
});

describe(
  "ArticleDetailPage — Telperiode en Status bewerken (aanvulling: \"telperiode en status moet je " +
    "ook kunnen aanpassen\")",
  () => {
    it("toont Telperiode en Status in de leesweergave, met de 4 vaste statusopties bewerkbaar", async () => {
      render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
      await waitUntilLoaded();

      expect(within(algemeenCard()).getByText("Maand")).toBeInTheDocument();
      expect(within(algemeenCard()).getByText("Actief")).toBeInTheDocument();
    });

    it("laat Telperiode en Status kiezen uit een vaste lijst en bewaart de juiste ruwe + genormaliseerde waarden", async () => {
      const user = userEvent.setup();
      render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
      await waitUntilLoaded();

      await user.click(screen.getByRole("button", { name: "Bewerken" }));

      const countPeriodSelect = screen.getByDisplayValue("Maand") as HTMLSelectElement;
      await user.selectOptions(countPeriodSelect, "Kwartaal");

      const statusSelect = screen.getByDisplayValue("Actief") as HTMLSelectElement;
      await user.selectOptions(statusSelect, "Obsolete - paneel");

      await user.click(screen.getByRole("button", { name: "Opslaan" }));

      await waitFor(() => {
        expect(within(algemeenCard()).getByText("Kwartaal")).toBeInTheDocument();
      });
      expect(within(algemeenCard()).getByText("Obsolete - paneel")).toBeInTheDocument();

      const [saved] = await countingRepository.getArticles("office-1");
      expect(saved.countPeriod).toBe("QUARTERLY");
      expect(saved.rawCountPeriod).toBe("KWARTAAL");
      expect(saved.status).toBe("INACTIVE");
      expect(saved.rawStatus).toBe("OBSOLETE - PANEEL");
    });

    it("annuleren laat Telperiode en Status ongemoeid", async () => {
      const user = userEvent.setup();
      render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
      await waitUntilLoaded();

      await user.click(screen.getByRole("button", { name: "Bewerken" }));
      await user.selectOptions(screen.getByDisplayValue("Actief") as HTMLSelectElement, "Non-actief");
      await user.click(screen.getByRole("button", { name: "Annuleren" }));

      expect(within(algemeenCard()).getByText("Actief")).toBeInTheDocument();
      const [saved] = await countingRepository.getArticles("office-1");
      expect(saved.status).toBe("ACTIVE");
      expect(saved.rawStatus).toBe("ACTIEF");
    });
  },
);

describe("ArticleDetailPage — Kostprijsevolutie (Sprint 3.1: historische grafiek/tabel gebruiken de BEVROREN snapshotprijs, nooit de levende Article-kostprijs)", () => {
  it("toont de bevroren kostprijs van een afgeronde telling in de Historiek-tabel, en een latere wijziging van de levende artikelkostprijs verandert dat bevroren punt niet", async () => {
    const locationId = "office-1:loc-1";
    await countingRepository.saveOffice({
      ...office,
      locations: [{ id: locationId, officeId: "office-1", number: 1, name: "Rek 1", active: true }],
    });

    // Rond een echte telling af — dit bevriest `article.costPrice` (€ 12,50)
    // in het `FinalizedSessionResult` van deze sessie.
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({ session, articleId: article.id, locationId, quantity: 5 });
    await countingService.completeLocation(session.id, locationId);
    await countSessionService.completeSession(session.id);

    render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
    await waitUntilLoaded();

    const historyCard = () => screen.getByText("Historiek").closest(".card") as HTMLElement;
    await waitFor(() => {
      expect(within(historyCard()).getByText("€ 12,50")).toBeInTheDocument();
    });
    // Voorraadwaarde op dit punt: 5 × € 12,50 = € 62,50.
    expect(within(historyCard()).getByText("€ 62,50")).toBeInTheDocument();

    // Nu wijzigt de LEVENDE artikelkostprijs (bv. een nieuwe leveranciersprijs) — dit mag de al bevroren Historiek nooit beïnvloeden.
    const [live] = await countingRepository.getArticles("office-1");
    await countingRepository.saveArticles([{ ...live, costPrice: 999 }]);

    await waitFor(() => {
      expect(within(algemeenCard()).getByText("€ 999,00")).toBeInTheDocument();
    });
    // De Historiek-rij van de al afgeronde telling toont nog steeds de oorspronkelijke, bevroren prijs.
    expect(within(historyCard()).getByText("€ 12,50")).toBeInTheDocument();
    expect(within(historyCard()).queryByText("€ 999,00")).not.toBeInTheDocument();
  });

  it("toont 'onbekend' voor de kostprijs/prijswijziging/voorraadwaarde wanneer een sessie geen bevroren FinalizedSessionResult heeft (legacy)", async () => {
    const locationId = "office-1:loc-1";
    await countingRepository.saveOffice({
      ...office,
      locations: [{ id: locationId, officeId: "office-1", number: 1, name: "Rek 1", active: true }],
    });

    // Simuleert een sessie COMPLETED vóór de data-integriteit-sprint (legacy
    // pad, zelfde patroon als `ComparisonService.test.ts`): de LEGACY
    // `repository.completeSession` rondt af ZONDER `FinalizedSessionResult`
    // weg te schrijven.
    const legacySession = await countSessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({ session: legacySession, articleId: article.id, locationId, quantity: 3 });
    await countingRepository.completeSession(legacySession.id);

    render(<ArticleDetailPage officeId="office-1" articleId="office-1:A1" />);
    await waitUntilLoaded();

    const historyCard = screen.getByText("Historiek").closest(".card") as HTMLElement;
    await waitFor(() => {
      expect(within(historyCard).getAllByText("onbekend").length).toBeGreaterThan(0);
    });
  });
});
