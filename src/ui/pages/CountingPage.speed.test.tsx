// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CountingPage } from "./CountingPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * v0.3 §1-6: de versnelde tel-flow op het telscherm — Enter-toetsenbediening,
 * automatische focus/scroll naar het volgende nog niet getelde artikel, de
 * standaardweergave "Nog te tellen" (met "Alles" tijdens leermodus), live
 * voortgang, en het samenspel van tabs/zoeken/hertellen. Eigen, geïsoleerde
 * fixture (los van CountingPage.test.tsx) zodat de exacte volgorde en
 * telstatus van de artikelen hier volledig onder controle staat.
 *
 * Zelfde testpatroon (echte IndexedDB via fake-indexeddb + de echte
 * application/container-services) als de rest van deze pagina's tests.
 */

const office: Office = {
  id: "office-speed",
  name: "Snelheid",
  baseDate: null,
  locations: [1, 2].map((n) => ({
    id: `office-speed:loc-${n}`,
    officeId: "office-speed",
    number: n,
    name: `Rek ${n}`,
    active: true,
  })),
};

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-speed:${overrides.articleNumber}`,
    officeId: "office-speed",
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

const articleA1 = makeArticle({ articleNumber: "A1", description: "Artikel A1" });
const articleA2 = makeArticle({ articleNumber: "A2", description: "Artikel A2" });
const articleA3 = makeArticle({ articleNumber: "A3", description: "Artikel A3" });
const articleA4 = makeArticle({ articleNumber: "A4", description: "Artikel A4" });

const loc1 = office.locations[0].id; // gekende locatie: A1/A2/A3 al "geleerd" (assignments), nog niets geteld.
const loc2 = office.locations[1].id; // nooit aangeraakt: pure leermodus.

let session: CountSession;

beforeEach(async () => {
  for (const table of [
    db.offices,
    db.articles,
    db.sessions,
    db.countEntries,
    db.assignments,
    db.importMeta,
    db.appState,
    db.locationSessionStatuses,
    db.productCategories,
  ]) {
    await table.clear();
  }

  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleA1, articleA2, articleA3, articleA4]);

  // A1/A2/A3 "geleerd" op loc-1 (assignments), VOOR het starten van de
  // sessie, zodat startSession() daar meteen ongetelde stub-entries voor
  // aanmaakt (spec v0.2.1 §9-mechanisme) — dat maakt loc-1 een normale,
  // niet-leermodus locatie met een voorspelbare, niet-lege "Nog te tellen".
  for (const article of [articleA1, articleA2, articleA3]) {
    await countingRepository.saveArticleLocationAssignment({
      id: `office-speed:${article.id}:${loc1}`,
      officeId: "office-speed",
      articleId: article.id,
      locationId: loc1,
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
  }

  session = await countSessionService.startSession("office-speed", "MONTHLY");
});

async function findCard(description: string): Promise<HTMLElement> {
  return (await screen.findByText(description)).closest(".article-card") as HTMLElement;
}

describe("CountingPage — Enter-toetsenbediening en automatisch doorschakelen (v0.3 §1-2)", () => {
  it("Enter slaat de huidige waarde op, springt naar het eerstvolgende niet-getelde artikel, en toont de eindmelding zodra alles geteld is", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={loc1} />);

    const a1Card = await findCard("Artikel A1");
    const a1Input = within(a1Card).getByPlaceholderText("0");

    // v0.3 §1: het hoeveelheidveld van het eerste (actieve) artikel krijgt
    // automatisch focus bij het openen van de locatie — geen extra tik nodig.
    await waitFor(() => {
      expect(document.activeElement).toBe(a1Input);
    });

    await user.type(a1Input, "5");
    await user.keyboard("{Enter}");

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === articleA1.id && e.locationId === loc1);
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(5);
    });

    // A1 verdwijnt meteen uit "Nog te tellen" (v0.3 §5), A2/A3 blijven.
    await waitFor(() => {
      expect(screen.queryByText("Artikel A1")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Artikel A2")).toBeInTheDocument();
    expect(screen.getByText("Artikel A3")).toBeInTheDocument();

    // Focus sprong naar A2 (de eerstvolgende NIET-getelde, niet A3).
    const a2Card = await findCard("Artikel A2");
    const a2Input = within(a2Card).getByPlaceholderText("0");
    await waitFor(() => {
      expect(document.activeElement).toBe(a2Input);
    });

    await user.type(a2Input, "0"); // v0.3 §1: 0 blijft een geldige expliciete telling.
    await user.keyboard("{Enter}");

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === articleA2.id && e.locationId === loc1);
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(0);
    });

    const a3Card = await findCard("Artikel A3");
    const a3Input = within(a3Card).getByPlaceholderText("0");
    await waitFor(() => {
      expect(document.activeElement).toBe(a3Input);
    });

    await user.type(a3Input, "2");
    await user.keyboard("{Enter}");

    // Geen volgende niet-getelde artikel meer -> duidelijke eindmelding.
    await waitFor(() => {
      expect(screen.getByText("Alle zichtbare artikelen zijn geteld.")).toBeInTheDocument();
    });
    expect(screen.queryByText("Artikel A1")).not.toBeInTheDocument();
    expect(screen.queryByText("Artikel A2")).not.toBeInTheDocument();
    expect(screen.queryByText("Artikel A3")).not.toBeInTheDocument();
  });

  it("'0' ingeven en Enter drukken op een op zichzelf staand artikel is een geldige, expliciete telling", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={loc1} />);

    const a1Card = await findCard("Artikel A1");
    const a1Input = within(a1Card).getByPlaceholderText("0");
    await user.type(a1Input, "0");
    await user.keyboard("{Enter}");

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === articleA1.id && e.locationId === loc1);
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(0);
    });
  });
});

describe("CountingPage — standaardweergave (v0.3 §3)", () => {
  it("default 'Nog te tellen' bij een normale telling met gekende assignments", async () => {
    render(<CountingPage sessionId={session.id} locationId={loc1} />);

    await screen.findByText("Artikel A1");

    const todoChip = screen.getByRole("button", { name: "Nog te tellen" });
    expect(todoChip).toHaveClass("chip--active");

    // Nog niets geteld op loc-1 -> alle drie de gekende artikelen zichtbaar.
    expect(screen.getByText("Artikel A2")).toBeInTheDocument();
    expect(screen.getByText("Artikel A3")).toBeInTheDocument();
    // A4 is hier nergens gekend/verwacht en dus geen deel van de "Nog te
    // tellen"-weergave voor deze locatie.
    expect(screen.queryByText("Artikel A4")).not.toBeInTheDocument();
  });

  it("eerste telling zonder locatiehistoriek (leermodus) behoudt de bestaande brede browse-flow (default 'Alles')", async () => {
    render(<CountingPage sessionId={session.id} locationId={loc2} />);

    await screen.findByText("Artikel A1");

    const allChip = screen.getByRole("button", { name: "Alles" });
    expect(allChip).toHaveClass("chip--active");

    // Leermodus: de volledige sessiescope is zichtbaar om te browsen.
    expect(screen.getByText("Artikel A2")).toBeInTheDocument();
    expect(screen.getByText("Artikel A3")).toBeInTheDocument();
    expect(screen.getByText("Artikel A4")).toBeInTheDocument();
  });
});

describe("CountingPage — voortgang, hertellen en het samenspel van tabs/zoeken (v0.3 §4, §6, §9-§10)", () => {
  it("de voortgang ('X / Y geteld', 'Z nog te tellen') wordt live bijgewerkt", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={loc1} />);

    await screen.findByText("Artikel A1");
    expect(screen.getByText("0 / 3 geteld")).toBeInTheDocument();
    expect(screen.getByText("3 nog te tellen")).toBeInTheDocument();

    const a1Card = await findCard("Artikel A1");
    await user.type(within(a1Card).getByPlaceholderText("0"), "5");
    await user.click(within(a1Card).getByRole("button", { name: /Geteld/ }));

    await waitFor(() => {
      expect(screen.getByText("1 / 3 geteld")).toBeInTheDocument();
      expect(screen.getByText("2 nog te tellen")).toBeInTheDocument();
    });
  });

  it("een reeds geteld artikel kan via de 'Geteld'-tab opnieuw geopend en herteld worden", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={loc1} />);

    const a1Card = await findCard("Artikel A1");
    await user.type(within(a1Card).getByPlaceholderText("0"), "5");
    await user.click(within(a1Card).getByRole("button", { name: /Geteld/ }));

    await waitFor(() => {
      expect(screen.queryByText("Artikel A1")).not.toBeInTheDocument(); // uit "Nog te tellen".
    });

    await user.click(screen.getByRole("button", { name: "Geteld" }));
    const recountCard = await findCard("Artikel A1"); // nu zichtbaar onder "Geteld".

    const input = within(recountCard).getByPlaceholderText("0") as HTMLInputElement;
    expect(input.value).toBe("5");
    await user.clear(input);
    await user.type(input, "8");
    await user.click(within(recountCard).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === articleA1.id && e.locationId === loc1);
      expect(entry?.quantity).toBe(8);
    });
  });

  it("zoeken en de primaire tabs blijven correct samenwerken (AND, niet OR)", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={loc1} />);

    await screen.findByText("Artikel A1");
    await user.click(screen.getByRole("button", { name: "Alles" }));
    const a2Card = await findCard("Artikel A2");
    await user.type(within(a2Card).getByPlaceholderText("0"), "1");
    await user.click(within(a2Card).getByRole("button", { name: /Geteld/ }));

    await waitFor(() => {
      // "Alles" + zoeken: A2 blijft zichtbaar, ongeacht telstatus.
      expect(screen.getByText("Artikel A2")).toBeInTheDocument();
    });

    // Het opslaan van A2 verplaatst (via requestAnimationFrame) de focus
    // automatisch naar het eerstvolgende niet-getelde artikel (A3, want A1
    // staat er nog vóór A2 in de volgorde). Wacht dat af vóórdat er in het
    // zoekveld getypt wordt, anders kan die asynchrone focusverplaatsing de
    // toetsaanslagen van `user.type` hieronder onderscheppen.
    const a3Card = await findCard("Artikel A3");
    const a3Input = within(a3Card).getByPlaceholderText("0");
    await waitFor(() => {
      expect(document.activeElement).toBe(a3Input);
    });

    const search = screen.getByPlaceholderText("Zoek op artikelnummer of omschrijving...");
    await user.type(search, "A2");
    expect(screen.getByText("Artikel A2")).toBeInTheDocument();
    expect(screen.queryByText("Artikel A1")).not.toBeInTheDocument();
    expect(screen.queryByText("Artikel A3")).not.toBeInTheDocument();

    // Combinatie met "Nog te tellen": A2 is al geteld, dus verdwijnt ondanks
    // de nog steeds actieve zoekopdracht (de tab en de zoekopdracht gelden
    // allebei tegelijk, niet los van elkaar).
    await user.click(screen.getByRole("button", { name: "Nog te tellen" }));
    expect(screen.queryByText("Artikel A2")).not.toBeInTheDocument();

    // En verschijnt opnieuw onder "Geteld", nog steeds met dezelfde zoekopdracht.
    await user.click(screen.getByRole("button", { name: "Geteld" }));
    expect(screen.getByText("Artikel A2")).toBeInTheDocument();
  });
});
