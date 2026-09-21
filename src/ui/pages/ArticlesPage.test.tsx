// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArticlesPage } from "./ArticlesPage";
import { db } from "../../adapters/storage/db";
import { countingRepository } from "../../application/container";
import type { Article, Office } from "../../domain/types";

/**
 * v0.2.1 correctieronde §1+§3A: dekt de kern-interacties op het compacte
 * Artikels-overzicht met de echte IndexedDB-laag (via fake-indexeddb) —
 * zoeken/sorteren/filters-modal/bulklocatiebeheer, en "+ Nieuw artikel".
 * De onderliggende bulklocatiefunctionaliteit is ONGEWIJZIGD t.o.v. de
 * vorige fase; enkel de manier waarop filters bereikt worden (nu achter een
 * "Filters"-knop) is aangepast.
 */

const office: Office = {
  id: "office-1",
  name: "Antwerpen",
  baseDate: null,
  locations: [1, 2].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n,
    name: `Rek ${n}`,
    active: true,
  })),
};

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: null,
    description: "Omschrijving",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
    ...overrides,
  };
}

const articleA1 = makeArticle({ articleNumber: "A1", description: "Alfa artikel" });
const articleA2 = makeArticle({ articleNumber: "A2", description: "Beta artikel" });
const articleA3 = makeArticle({ articleNumber: "A3", description: "Gamma artikel", productGroup: "ANDERE" });

beforeEach(async () => {
  for (const table of [db.offices, db.articles, db.sessions, db.countEntries, db.assignments, db.appState]) {
    await table.clear();
  }
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleA1, articleA2, articleA3]);
});

/** `useOffice`/`useArticles` laden async (dexie-react-hooks) — wacht tot het scherm klaar is. */
async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
  });
}

/** Opent de compacte "Filters"-modal (v0.2.1 correctieronde §1). */
async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
  // De modal is herkenbaar aan haar unieke "Toepassen"-knop (i.p.v. de tekst
  // "Filters", die ook los op de toolbarknop voorkomt en dus ambigu is).
  return screen.getByRole("button", { name: "Toepassen" }).closest(".modal-card") as HTMLElement;
}

describe("ArticlesPage — compacte toolbar (v0.2.1 correctieronde §1)", () => {
  it("toont een compacte toolbar i.p.v. permanente filterrijen, met 'Filters' zonder telling wanneer niets actief is", async () => {
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    expect(screen.getByPlaceholderText("Zoeken...")).toBeInTheDocument();
    expect(screen.getByLabelText("Sorteren")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Nieuw artikel" })).toBeInTheDocument();
  });

  it("zoeken werkt nog steeds via het toolbar-zoekveld", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.type(screen.getByPlaceholderText("Zoeken..."), "alfa");
    expect(screen.getByText("Alfa artikel")).toBeInTheDocument();
    expect(screen.queryByText("Beta artikel")).not.toBeInTheDocument();
  });

  it("sorteren via de dropdown blijft correct (bv. Artikelnummer)", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.selectOptions(screen.getByLabelText("Sorteren"), "Artikelnummer");
    const descriptions = document.querySelectorAll(".article-card__description");
    // Op artikelnummer: A1, A2, A3 — dus Alfa, Beta, Gamma in die volgorde
    // (anders dan de standaardsortering Productgroep -> Omschrijving, waarbij
    // Gamma — productgroep "ANDERE" — eerst zou komen).
    expect(Array.from(descriptions).map((el) => el.textContent)).toEqual([
      "Alfa artikel",
      "Beta artikel",
      "Gamma artikel",
    ]);
  });

  it("de Filters-knop toont het aantal actieve filters, en filters blijven volledig functioneel achter de modal", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    let modal = await openFilters(user);
    await user.click(within(modal).getByRole("button", { name: "ANDERE" }));
    // Modal blijft open (geen auto-close per klik) — expliciet sluiten via "Toepassen".
    await user.click(within(modal).getByRole("button", { name: "Toepassen" }));

    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
    expect(screen.getByText("Gamma artikel")).toBeInTheDocument();
    expect(screen.queryByText("Alfa artikel")).not.toBeInTheDocument();

    // Actieve filter is ook zichtbaar/snel wisbaar als chip buiten de modal.
    const removableChip = screen.getByText("Productgroep: ANDERE").closest(".location-chip") as HTMLElement;
    await user.click(within(removableChip).getByRole("button"));
    expect(screen.getByText("Alfa artikel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();

    // Meerdere filters combineren: productgroep + "Geen locatie".
    modal = await openFilters(user);
    await user.click(within(modal).getByRole("button", { name: "GROEP" }));
    await user.click(within(modal).getByRole("button", { name: "Geen locatie" }));
    await user.click(within(modal).getByRole("button", { name: "Toepassen" }));

    expect(screen.getByRole("button", { name: "Filters (2)" })).toBeInTheDocument();
    expect(screen.getByText("Alfa artikel")).toBeInTheDocument();
    expect(screen.getByText("Beta artikel")).toBeInTheDocument();
    expect(screen.queryByText("Gamma artikel")).not.toBeInTheDocument(); // andere productgroep
  });

  it("'Geen locatie' filter (in de modal) toont enkel artikelen zonder actieve locatiekoppeling", async () => {
    const user = userEvent.setup();
    await countingRepository.saveArticleLocationAssignments([
      {
        id: "office-1:office-1:A1:office-1:loc-1",
        officeId: "office-1",
        articleId: "office-1:A1",
        locationId: "office-1:loc-1",
        active: true,
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    const modal = await openFilters(user);
    await user.click(within(modal).getByRole("button", { name: "Geen locatie" }));
    await user.click(within(modal).getByRole("button", { name: "Toepassen" }));

    expect(screen.queryByText("Alfa artikel")).not.toBeInTheDocument();
    expect(screen.getByText("Beta artikel")).toBeInTheDocument();
    expect(screen.getByText("Gamma artikel")).toBeInTheDocument();
  });
});

describe("ArticlesPage — bulkselectie en bulkacties (ongewijzigd, v0.2.1 §1-2)", () => {
  it("meerdere artikels selecteren, en 'Locatie toevoegen' koppelt de gekozen locatie aan elk van hen", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("checkbox", { name: "Selecteer Alfa artikel" }));
    await user.click(screen.getByRole("checkbox", { name: "Selecteer Beta artikel" }));
    expect(screen.getByText("2 artikel(en) geselecteerd")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Locatie toevoegen" }));
    const modal = screen.getByText("Kies een locatie.").closest(".modal-card") as HTMLElement;
    await user.click(within(modal).getByRole("button", { name: "Rek 1" }));

    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    const active = assignments.filter((a) => a.locationId === "office-1:loc-1" && a.active);
    expect(active.map((a) => a.articleId).sort()).toEqual(["office-1:A1", "office-1:A2"]);

    // De bulkbalk verdwijnt na uitvoeren (selectie gewist).
    expect(screen.queryByText(/artikel\(en\) geselecteerd/)).not.toBeInTheDocument();
  });

  it("select all filtered: 'Selecteer alles' selecteert alle op dat moment gefilterde artikelen", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.type(screen.getByPlaceholderText("Zoeken..."), "artikel");
    await user.click(screen.getByRole("checkbox", { name: "Selecteer alle gefilterde artikelen" }));

    expect(screen.getByText("3 artikel(en) geselecteerd")).toBeInTheDocument();
  });

  it("quick '+ Locatie' vanuit de artikelrij voegt meteen een locatie toe, zonder naar het detail te navigeren", async () => {
    const user = userEvent.setup();
    let opened = false;
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => (opened = true)} />);
    await waitUntilLoaded();

    const row = (await screen.findByText("Alfa artikel")).closest(".article-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "+ Locatie" }));
    await user.selectOptions(within(row).getByRole("combobox"), "office-1:loc-2");
    await user.click(within(row).getByRole("button", { name: "Toevoegen" }));

    expect(await within(row).findByText("Rek 2")).toBeInTheDocument();
    expect(opened).toBe(false);

    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    expect(
      assignments.some((a) => a.articleId === "office-1:A1" && a.locationId === "office-1:loc-2" && a.active),
    ).toBe(true);
  });

  it("meerdere locatiechips per artikel: na een tweede quick-add staan beide chips op de rij", async () => {
    const user = userEvent.setup();
    await countingRepository.saveArticleLocationAssignments([
      {
        id: "office-1:office-1:A1:office-1:loc-1",
        officeId: "office-1",
        articleId: "office-1:A1",
        locationId: "office-1:loc-1",
        active: true,
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    const row = (await screen.findByText("Alfa artikel")).closest(".article-row") as HTMLElement;
    expect(within(row).getByText("Rek 1")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "+ Locatie" }));
    await user.selectOptions(within(row).getByRole("combobox"), "office-1:loc-2");
    await user.click(within(row).getByRole("button", { name: "Toevoegen" }));

    expect(await within(row).findByText("Rek 2")).toBeInTheDocument();
    expect(within(row).getByText("Rek 1")).toBeInTheDocument();
  });
});

describe("ArticlesPage — '+ Nieuw artikel' (v0.2.1 correctieronde §3A)", () => {
  it("maakt een nieuw artikel aan met een tijdelijk artikelnummer en toont het meteen in de lijst", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "+ Nieuw artikel" }));
    const modal = screen.getByText("Nieuw artikel").closest(".modal-card") as HTMLElement;

    await user.type(within(modal).getByLabelText("Omschrijving *"), "Onderweg gekocht onderdeel");
    await user.type(within(modal).getByLabelText("Productgroep *"), "Nieuw");
    await user.type(within(modal).getByLabelText("Eenheid *"), "stuk");
    await user.click(within(modal).getByRole("button", { name: "Rek 1" }));
    await user.click(within(modal).getByRole("button", { name: "Artikel aanmaken" }));

    await waitFor(() => {
      expect(screen.queryByText("Nieuw artikel")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("Onderweg gekocht onderdeel")).toBeInTheDocument();

    const articles = await countingRepository.getArticles("office-1");
    const created = articles.find((a) => a.description === "Onderweg gekocht onderdeel");
    expect(created?.idType).toBe("TIJDELIJK");
    expect(created?.articleNumber).toMatch(/^TMP-ANT-\d{4}$/);
    expect(created?.officialArticleNumber).toBeNull();

    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    expect(assignments.some((a) => a.articleId === created?.id && a.locationId === "office-1:loc-1")).toBe(
      true,
    );
  });

  it("de knop blijft uitgeschakeld zolang de verplichte velden niet ingevuld zijn", async () => {
    const user = userEvent.setup();
    render(<ArticlesPage officeId="office-1" onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "+ Nieuw artikel" }));
    const modal = screen.getByText("Nieuw artikel").closest(".modal-card") as HTMLElement;
    expect(within(modal).getByRole("button", { name: "Artikel aanmaken" })).toBeDisabled();
  });
});
