// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocationOverviewPage } from "./LocationOverviewPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countSessionService } from "../../application/container";
import type { Article, Office } from "../../domain/types";

/**
 * v0.2.1 correctieronde §2: "Zonder locatie"-kaart op het locatie-overzicht,
 * voor elke tellingsoort. Zelfde testpatroon (echte IndexedDB via
 * fake-indexeddb) als ArticlesPage.test.tsx/CountingPage.test.tsx.
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

beforeEach(async () => {
  for (const table of [db.offices, db.articles, db.sessions, db.countEntries, db.assignments, db.appState, db.productCategories]) {
    await table.clear();
  }
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleA1, articleA2]);
});

async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
  });
}

describe("LocationOverviewPage — 'Zonder locatie' (v0.2.1 correctieronde §2)", () => {
  it("toont de kaart met het aantal artikelen zonder actieve locatiekoppeling, ook bij elke tellingsoort", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    expect(await screen.findByText("Zonder locatie")).toBeInTheDocument();
    expect(screen.getByText("2 artikelen")).toBeInTheDocument();
  });

  it("een artikel verdwijnt uit 'Zonder locatie' zodra het een actieve locatie krijgt", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    await countingRepository.saveArticleLocationAssignment({
      id: "office-1:office-1:A1:office-1:loc-1",
      officeId: "office-1",
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    expect(await screen.findByText("1 artikelen")).toBeInTheDocument();
  });

  it("toont de kaart ook wanneer het aantal 0 is (consistente aanpak, spec §2)", async () => {
    await countingRepository.saveArticleLocationAssignment({
      id: "office-1:office-1:A1:office-1:loc-1",
      officeId: "office-1",
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    await countingRepository.saveArticleLocationAssignment({
      id: "office-1:office-1:A2:office-1:loc-1",
      officeId: "office-1",
      articleId: "office-1:A2",
      locationId: "office-1:loc-1",
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    expect(await screen.findByText("Zonder locatie")).toBeInTheDocument();
    expect(screen.getByText("0 artikelen")).toBeInTheDocument();
  });

  it("klikken op de kaart roept onOpenWithoutLocation aan, en maakt geen fysieke locatie aan", async () => {
    const user = userEvent.setup();
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    let opened = false;
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => (opened = true)}
      />,
    );
    await waitUntilLoaded();

    await user.click(await screen.findByText("Zonder locatie"));
    expect(opened).toBe(true);

    const officeAfter = await countingRepository.getOffice("office-1");
    expect(officeAfter?.locations).toHaveLength(2); // ongewijzigd — geen fake Location aangemaakt.
  });

  it("toont voor een nog nooit getelde locatie (leermodus) de sessiebrede totaaltelling als richtgetal i.p.v. '0 / 0'", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    // Rek 1 en Rek 2 zijn allebei nog nooit aangeraakt (geen assignments,
    // geen entries) -> geen van beide toont de misleidende "0 / 0 geteld".
    // In plaats daarvan het sessiebrede totaal (hier: 2 artikelen).
    expect(screen.queryByText("0 / 0 geteld")).not.toBeInTheDocument();
    expect(screen.getAllByText("0 / 2 geteld")).toHaveLength(2);
  });

  it("laat een echte, locatie-specifieke teller verschijnen zodra er op die locatie geteld is", async () => {
    await countingRepository.saveArticleLocationAssignment({
      id: "office-1:office-1:A1:office-1:loc-1",
      officeId: "office-1",
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    // Rek 1 heeft nu wél een gekend artikel (1 stub-entry bij sessiestart)
    // -> een echte teller, geen richtgetal.
    expect(await screen.findByText("0 / 1 geteld")).toBeInTheDocument();
    // Rek 2 is nog steeds onaangeraakt -> blijft het sessiebrede richtgetal tonen.
    expect(screen.getByText("0 / 2 geteld")).toBeInTheDocument();
  });

  it("werkt voor kwartaaltelling net zoals voor maandtelling", async () => {
    const session = await countSessionService.startSession("office-1", "QUARTERLY");
    render(
      <LocationOverviewPage
        sessionId={session.id}
        onOpenLocation={() => {}}
        onOpenReview={() => {}}
        onOpenWithoutLocation={() => {}}
      />,
    );
    await waitUntilLoaded();
    expect(await screen.findByText("Zonder locatie")).toBeInTheDocument();
    expect(screen.getByText("2 artikelen")).toBeInTheDocument();
  });
});
