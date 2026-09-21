// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithoutLocationPage } from "./WithoutLocationPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countSessionService } from "../../application/container";
import type { Article, Office } from "../../domain/types";

/**
 * v0.2.1 correctieronde §2: de "Zonder locatie"-werklijst zelf — zoeken,
 * sorteren, productgroepfilter, en snel een locatie toewijzen via de
 * gedeelde bulk-component (dezelfde LocationAssignmentService-aanroepen als
 * ArticlesPage.test.tsx).
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

const articleA1 = makeArticle({ articleNumber: "A1", description: "Alfa artikel", productGroup: "Groep A" });
const articleA2 = makeArticle({ articleNumber: "A2", description: "Beta artikel", productGroup: "Groep B" });
const articleA3 = makeArticle({ articleNumber: "A3", description: "Gamma artikel", productGroup: "Groep A" });

beforeEach(async () => {
  for (const table of [db.offices, db.articles, db.sessions, db.countEntries, db.assignments, db.appState]) {
    await table.clear();
  }
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleA1, articleA2, articleA3]);
});

async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
  });
}

describe("WithoutLocationPage (v0.2.1 correctieronde §2)", () => {
  it("toont enkel de artikelen zonder actieve locatiekoppeling van de sessiescope", async () => {
    await countingRepository.saveArticleLocationAssignment({
      id: "office-1:office-1:A2:office-1:loc-1",
      officeId: "office-1",
      articleId: "office-1:A2",
      locationId: "office-1:loc-1",
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(<WithoutLocationPage sessionId={session.id} onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    expect(screen.getByText("Alfa artikel")).toBeInTheDocument();
    expect(screen.getByText("Gamma artikel")).toBeInTheDocument();
    expect(screen.queryByText("Beta artikel")).not.toBeInTheDocument();
  });

  it("filtert op productgroep", async () => {
    const user = userEvent.setup();
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(<WithoutLocationPage sessionId={session.id} onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "Groep B" }));
    expect(screen.queryByText("Alfa artikel")).not.toBeInTheDocument();
    expect(screen.getByText("Beta artikel")).toBeInTheDocument();
  });

  it("snel een locatie toewijzen via '+ Locatie' laat het artikel meteen verdwijnen uit de lijst", async () => {
    const user = userEvent.setup();
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(<WithoutLocationPage sessionId={session.id} onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    const row = (await screen.findByText("Alfa artikel")).closest(".article-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "+ Locatie" }));
    await user.selectOptions(within(row).getByRole("combobox"), "office-1:loc-1");
    await user.click(within(row).getByRole("button", { name: "Toevoegen" }));

    await waitFor(() => {
      expect(screen.queryByText("Alfa artikel")).not.toBeInTheDocument();
    });

    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    expect(
      assignments.some((a) => a.articleId === "office-1:A1" && a.locationId === "office-1:loc-1" && a.active),
    ).toBe(true);
  });

  it("maakt geen fake Location-record aan", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(<WithoutLocationPage sessionId={session.id} onOpenArticle={() => {}} />);
    await waitUntilLoaded();

    const officeAfter = await countingRepository.getOffice("office-1");
    expect(officeAfter?.locations.map((l) => l.name).sort()).toEqual(["Rek 1", "Rek 2"]);
  });
});
