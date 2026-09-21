// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CountingPage } from "./CountingPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * v0.2.1-hotfix — de blokkerende regressie zelf, maar dan op de plek waar
 * de bug écht zat: `defaultPool` op het telscherm. Dit test bewust MET de
 * echte IndexedDB-laag (via fake-indexeddb) en de echte
 * `application/container`-services, niet met gemockte props — anders test
 * je enkel dat de component doet wat je erin stopt, niet dat "Tellen" vanuit
 * Review daadwerkelijk een teloplossing biedt voor een artikel dat hier
 * (op déze locatie) nog nergens gekend is.
 *
 * Reproductie van de bug: locatie 1 is NIET in "learning mode" (M1 is er al
 * gekend/geteld), dus `knownAtLocation` bestaat uit enkel M1. Een tweede
 * artikel M2, dat nergens een CountEntry of ArticleLocationAssignment heeft,
 * valt daardoor buiten `defaultPool` — vóór de fix verscheen M2 dan nergens
 * op het scherm, ook niet met `focusArticleId`.
 */

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
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

const articleM1 = makeArticle({ articleNumber: "M1", description: "Sigen BAT 8" });
const articleM2 = makeArticle({ articleNumber: "M2", description: "Nooit geteld artikel" });

let session: CountSession;

beforeEach(async () => {
  // Elke test start met een lege database (dezelfde gedeelde singleton die
  // CountingPage/container.ts ook gebruiken — vandaar geen eigen AppDatabase-naam).
  for (const table of [
    db.offices,
    db.articles,
    db.sessions,
    db.countEntries,
    db.assignments,
    db.importMeta,
    db.appState,
    db.locationSessionStatuses,
  ]) {
    await table.clear();
  }

  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleM1, articleM2]);
  session = await countSessionService.startSession("office-1", "MONTHLY");

  // M1 al geteld op locatie 1 -> locatie 1 is NIET (meer) in "learning mode",
  // en M2 heeft nergens een entry of assignment -> exact de bug-situatie.
  await countingService.recordCount({
    session,
    articleId: articleM1.id,
    locationId: office.locations[0].id,
    quantity: 3,
  });
});

describe("CountingPage — 'Tellen' op een artikel zonder bestaande CountEntry (v0.2.1-hotfix)", () => {
  it("toont het gefocuste artikel ook wanneer het hier nog geen entry/verwachting heeft, en laat het meteen tellen", async () => {
    const user = userEvent.setup();
    render(
      <CountingPage sessionId={session.id} locationId={office.locations[0].id} focusArticleId={articleM2.id} />,
    );

    // Zonder de fix zou M2 hier nooit verschijnen (buiten defaultPool).
    const card = await waitFor(() => {
      const description = screen.getByText("Nooit geteld artikel");
      return description.closest(".article-card") as HTMLElement;
    });
    expect(card).toBeTruthy();

    // Rechtstreeks vanuit dit scherm de hoeveelheid ingeven en "Geteld" kiezen.
    const input = within(card).getByPlaceholderText("0");
    await user.type(input, "7");
    await user.click(within(card).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find(
        (e) => e.articleId === articleM2.id && e.locationId === office.locations[0].id,
      );
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(7);
    });
  });

  it("blijft het al-gekende artikel (M1) tonen naast het nieuw gefocuste artikel", async () => {
    render(
      <CountingPage sessionId={session.id} locationId={office.locations[0].id} focusArticleId={articleM2.id} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Nooit geteld artikel")).toBeInTheDocument();
    });
    expect(screen.getByText("Sigen BAT 8")).toBeInTheDocument();
  });
});

describe("CountingPage — labels en visueel onderscheid (v0.2.1 correctieronde, UX-fix)", () => {
  it("toont '+ Bestaand artikel opzoeken' (niet meer '+ Ander artikel tellen') als subtielere tekstlink, en '+ Nieuw artikel gevonden' als volwaardige knop", async () => {
    render(<CountingPage sessionId={session.id} locationId={office.locations[0].id} />);
    await waitFor(() => {
      expect(screen.getByText("Sigen BAT 8")).toBeInTheDocument();
    });

    expect(screen.queryByText("+ Ander artikel tellen")).not.toBeInTheDocument();

    const lookupButton = screen.getByRole("button", { name: "+ Bestaand artikel opzoeken" });
    expect(lookupButton).toHaveClass("text-link-button");

    const newArticleButton = screen.getByRole("button", { name: "+ Nieuw artikel gevonden" });
    expect(newArticleButton).toHaveClass("big-button", "big-button--secondary");
  });
});

describe("CountingPage — '+ Nieuw artikel gevonden' (v0.2.1 correctieronde §3B)", () => {
  it("maakt een nieuw artikel aan, koppelt de huidige locatie en telt het meteen — verschijnt in Review", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={office.locations[0].id} />);

    await waitFor(() => {
      expect(screen.getByText("Sigen BAT 8")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "+ Nieuw artikel gevonden" }));
    const modal = screen.getByText("Nieuw artikel gevonden").closest(".modal-card") as HTMLElement;
    expect(within(modal).getByText(/Rek 1/)).toBeInTheDocument();

    await user.type(within(modal).getByLabelText("Omschrijving *"), "Onverwacht onderdeel");
    await user.type(within(modal).getByLabelText("Productgroep *"), "Nieuw");
    await user.type(within(modal).getByLabelText("Eenheid *"), "stuk");
    await user.type(within(modal).getByLabelText("Getelde hoeveelheid *"), "4");
    await user.click(within(modal).getByRole("button", { name: "Opslaan en tellen" }));

    await waitFor(() => {
      expect(screen.queryByText("Nieuw artikel gevonden")).not.toBeInTheDocument();
    });

    const articles = await countingRepository.getArticles("office-1");
    const created = articles.find((a) => a.description === "Onverwacht onderdeel");
    expect(created).toBeDefined();
    expect(created?.idType).toBe("TIJDELIJK");
    expect(created?.articleNumber).toMatch(/^TMP-ANT-\d{4}$/);

    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    expect(
      assignments.some(
        (a) => a.articleId === created?.id && a.locationId === office.locations[0].id && a.active,
      ),
    ).toBe(true);

    const entries = await countingRepository.getCountEntries(session.id);
    const entry = entries.find((e) => e.articleId === created?.id);
    expect(entry?.counted).toBe(true);
    expect(entry?.quantity).toBe(4);

    // Buiten sessiescope (net als de bestaande "buiten scope"-toevoegingen) —
    // dat is precies wat domain/review.ts als "handmatige toevoeging" herkent.
    expect(session.articleIds.includes(created!.id)).toBe(false);
  });

  it("een expliciete hoeveelheid 0 is een geldige invoer", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={office.locations[0].id} />);
    await waitFor(() => {
      expect(screen.getByText("Sigen BAT 8")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "+ Nieuw artikel gevonden" }));
    const modal = screen.getByText("Nieuw artikel gevonden").closest(".modal-card") as HTMLElement;

    await user.type(within(modal).getByLabelText("Omschrijving *"), "Leeg gevonden onderdeel");
    await user.type(within(modal).getByLabelText("Productgroep *"), "Nieuw");
    await user.type(within(modal).getByLabelText("Eenheid *"), "stuk");
    await user.type(within(modal).getByLabelText("Getelde hoeveelheid *"), "0");
    await user.click(within(modal).getByRole("button", { name: "Opslaan en tellen" }));

    await waitFor(() => {
      expect(screen.queryByText("Nieuw artikel gevonden")).not.toBeInTheDocument();
    });

    const articles = await countingRepository.getArticles("office-1");
    const created = articles.find((a) => a.description === "Leeg gevonden onderdeel");
    const entries = await countingRepository.getCountEntries(session.id);
    const entry = entries.find((e) => e.articleId === created?.id);
    expect(entry?.counted).toBe(true);
    expect(entry?.quantity).toBe(0);
  });
});
