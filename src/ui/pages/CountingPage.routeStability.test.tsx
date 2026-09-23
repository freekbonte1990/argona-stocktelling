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
 * v0.3-hotfix (blokkerende bug, gemeld tijdens mobiel testen): "de actieve
 * locatie verspringt" en "na tellen van één artikel terug naar het
 * hoofdmenu". `CountingPage` krijgt geen enkele navigatiecallback als prop
 * — het kan dus structureel nooit zelf "wegnavigeren". Deze tests leggen dat
 * vast voor exact de scenario's uit de bugmelding: tellen, een automatisch
 * geleerde assignment, en het bevestigen van "onverwachte locatie" mogen
 * NOOIT de huidige `locationId`/paginatitel veranderen — enkel de expliciete
 * Back-knop (in App.tsx, hier niet eens bereikbaar vanuit dit component) mag
 * de pagina verlaten. Zie ook App.test.tsx voor de route-herstel-tests op
 * app-niveau (de eigenlijke oorzaak: routestate die een mobiele
 * achtergrond-herlaad niet overleefde).
 */

const office: Office = {
  id: "office-1",
  name: "Antwerpen",
  baseDate: null,
  locations: [
    { id: "office-1:loc-A", officeId: "office-1", number: 1, name: "Rek A", active: true },
    { id: "office-1:loc-B", officeId: "office-1", number: 2, name: "Rek B", active: true },
  ],
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

const articleM1 = makeArticle({ articleNumber: "M1", description: "Artikel M1" });
const articleM2 = makeArticle({ articleNumber: "M2", description: "Artikel M2 (nog nergens gekend)" });

const locA = office.locations[0].id;
const locB = office.locations[1].id;

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
  ]) {
    await table.clear();
  }
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleM1, articleM2]);
  // M1 is "gekend" op Rek A, VOOR sessiestart — Rek B blijft leermodus voor M1.
  await countingRepository.saveArticleLocationAssignment({
    id: `office-1:${articleM1.id}:${locA}`,
    officeId: "office-1",
    articleId: articleM1.id,
    locationId: locA,
    active: true,
    lastSeenAt: new Date().toISOString(),
  });
  session = await countSessionService.startSession("office-1", "MONTHLY");
});

function title(): string | null {
  return document.querySelector(".screen-title")?.textContent ?? null;
}

describe("CountingPage — route/locatie blijft stabiel (v0.3-hotfix)", () => {
  it("route blijft op dezelfde location.id ná tellen van een artikel", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={locB} />);

    await screen.findByText("Artikel M2 (nog nergens gekend)");
    expect(title()).toBe("Antwerpen > Rek B");

    const card = (await screen.findByText("Artikel M2 (nog nergens gekend)")).closest(
      ".article-card",
    ) as HTMLElement;
    await user.type(within(card).getByPlaceholderText("0"), "4");
    await user.click(within(card).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      expect(entries.some((e) => e.articleId === articleM2.id && e.counted)).toBe(true);
    });
    // Nog steeds exact dezelfde locatie — geen navigatie.
    expect(title()).toBe("Antwerpen > Rek B");
  });

  it("route blijft op dezelfde locatie nadat tellen automatisch een nieuwe assignment leert", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={locB} />);

    const card = (await screen.findByText("Artikel M2 (nog nergens gekend)")).closest(
      ".article-card",
    ) as HTMLElement;
    await user.type(within(card).getByPlaceholderText("0"), "1");
    await user.click(within(card).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const assignments = await countingRepository.getArticleLocationAssignments("office-1");
      expect(
        assignments.some((a) => a.articleId === articleM2.id && a.locationId === locB && a.active),
      ).toBe(true);
    });
    expect(title()).toBe("Antwerpen > Rek B");
  });

  it("route blijft op dezelfde locatie na het bevestigen van 'onverwachte locatie', en telt daadwerkelijk hier (niet op Rek A)", async () => {
    const user = userEvent.setup();
    // M1 wordt normaal op Rek A verwacht — hier tellen we het bewust op Rek B.
    // Rek B heeft zelf nog geen gekende artikelen (leermodus), dus de
    // standaardweergave "Alles" toont sowieso de hele sessiescope, M1
    // inbegrepen — geen "+ Bestaand artikel opzoeken" nodig.
    render(<CountingPage sessionId={session.id} locationId={locB} />);

    // v0.3 §1: bij het openen krijgt het eerste artikel (M1, alfabetisch
    // eerst) automatisch focus via requestAnimationFrame. Die asynchrone
    // focusverplaatsing moet eerst voltooid zijn, anders kan ze de
    // toetsaanslagen hieronder in het zoekveld onderscheppen (zie ook de
    // gelijkaardige fix in CountingPage.speed.test.tsx).
    const m1Card = (await screen.findByText("Artikel M1")).closest(".article-card") as HTMLElement;
    const m1Input = within(m1Card).getByPlaceholderText("0");
    await waitFor(() => {
      expect(document.activeElement).toBe(m1Input);
    });

    await user.type(
      screen.getByPlaceholderText("Zoek op artikelnummer of omschrijving..."),
      "Artikel M1",
    );
    const card = (await screen.findByText("Artikel M1")).closest(".article-card") as HTMLElement;
    await user.type(within(card).getByPlaceholderText("0"), "9");
    await user.click(within(card).getByRole("button", { name: /Geteld/ }));

    // De bevestigingsmodal moet verschijnen, MET Rek B als huidige locatie.
    expect(
      await screen.findByText(/Dit artikel werd normaal op Rek A verwacht, maar wordt nu op Rek B geteld\./),
    ).toBeInTheDocument();
    expect(title()).toBe("Antwerpen > Rek B"); // de modal zelf verandert de route niet.

    await user.click(screen.getByRole("button", { name: "Ja, toevoegen" }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find((e) => e.articleId === articleM1.id && e.locationId === locB);
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(9);
    });
    // Beide koppelingen blijven bestaan (spec: artikel op meerdere locaties) —
    // en we zijn NOG STEEDS op Rek B, niet teruggestuurd naar Rek A of Home.
    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    expect(assignments.some((a) => a.articleId === articleM1.id && a.locationId === locA && a.active)).toBe(
      true,
    );
    expect(assignments.some((a) => a.articleId === articleM1.id && a.locationId === locB && a.active)).toBe(
      true,
    );
    expect(title()).toBe("Antwerpen > Rek B");
  });

  it("het laatste zichtbare artikel tellen geeft geen navigatie — enkel de eindmelding, op dezelfde pagina", async () => {
    const user = userEvent.setup();
    // Enige artikel dat op Rek A verwacht wordt: M1 zelf.
    render(<CountingPage sessionId={session.id} locationId={locA} />);

    const card = (await screen.findByText("Artikel M1")).closest(".article-card") as HTMLElement;
    await user.type(within(card).getByPlaceholderText("0"), "3");
    await user.click(within(card).getByRole("button", { name: /Geteld/ }));

    await waitFor(() => {
      expect(screen.getByText("Alle zichtbare artikels zijn geteld.")).toBeInTheDocument();
    });
    // Nog steeds dezelfde pagina/locatie — geen navigatie naar Home of het overzicht.
    expect(title()).toBe("Antwerpen > Rek A");
  });
});
