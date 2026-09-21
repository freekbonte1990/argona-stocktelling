// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewPage } from "./ReviewPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * v0.2.1 §6 (afrondlogica): het reviewscherm moet vóór afronden duidelijk
 * tonen hoeveel locaties/artikelen nog open staan, de "Telling afronden"-knop
 * disabled houden zolang niet aan beide voorwaarden voldaan is, en een
 * rechtstreekse link bieden naar elke nog niet afgeronde locatie. Zelfde
 * testpatroon (echte IndexedDB via fake-indexeddb + de echte
 * application/container-services) als CountingPage.test.tsx/
 * LocationOverviewPage.test.tsx.
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

const articleM1 = makeArticle({ articleNumber: "M1", description: "Eerste artikel" });
const articleM2 = makeArticle({ articleNumber: "M2", description: "Tweede artikel" });

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
  session = await countSessionService.startSession("office-1", "MONTHLY");
});

async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
  });
}

describe("ReviewPage — afrondvoorwaarden (v0.2.1 §6)", () => {
  it("toont '1 / 2 locaties afgerond' en '1 / 2 artikels afgewerkt', en houdt 'Telling afronden' disabled", async () => {
    await countingService.recordCount({
      session,
      articleId: articleM1.id,
      locationId: office.locations[0].id,
      quantity: 3,
    });
    // M2 blijft ongeteld. Enkel locatie 1 wordt afgerond.
    await countingService.completeLocation(session.id, office.locations[0].id);

    render(
      <ReviewPage
        sessionId={session.id}
        onRecount={() => {}}
        onCompleted={() => {}}
        onOpenLocationOverview={() => {}}
        onOpenLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("1 / 2")).toHaveLength(2); // locaties afgerond + artikels afgewerkt
    });
    expect(screen.getByText("Locaties afgerond")).toBeInTheDocument();
    expect(screen.getByText("Artikels afgewerkt")).toBeInTheDocument();

    // Melding noemt zowel de open locatie als het onopgeloste artikel.
    expect(screen.getByText(/1 locatie is nog niet afgerond/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rek 2" })).toBeInTheDocument();
    expect(screen.getByText(/Nog 1 artikel\(en\) in scope zijn niet/)).toBeInTheDocument();

    const completeButton = screen.getByRole("button", { name: "Telling afronden" });
    expect(completeButton).toBeDisabled();
  });

  it("klikken op de naam van een niet-afgeronde locatie roept onOpenLocation aan met de juiste locationId", async () => {
    const user = userEvent.setup();
    let openedLocationId: string | null = null;

    render(
      <ReviewPage
        sessionId={session.id}
        onRecount={() => {}}
        onCompleted={() => {}}
        onOpenLocationOverview={() => {}}
        onOpenLocation={(locationId) => (openedLocationId = locationId)}
      />,
    );
    await waitUntilLoaded();

    await user.click(await screen.findByRole("button", { name: "Rek 1" }));
    expect(openedLocationId).toBe(office.locations[0].id);
  });

  it("activeert 'Telling afronden' pas zodra alle locaties afgerond en alle artikelen opgelost zijn", async () => {
    await countingService.recordCount({
      session,
      articleId: articleM1.id,
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.confirmAbsent(session, articleM2.id);
    await countingService.completeLocation(session.id, office.locations[0].id);
    await countingService.completeLocation(session.id, office.locations[1].id);

    render(
      <ReviewPage
        sessionId={session.id}
        onRecount={() => {}}
        onCompleted={() => {}}
        onOpenLocationOverview={() => {}}
        onOpenLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    await waitFor(() => {
      expect(screen.getAllByText("2 / 2")).toHaveLength(2); // locaties afgerond + artikels afgewerkt
    });
    const completeButton = screen.getByRole("button", { name: "Telling afronden" });
    expect(completeButton).not.toBeDisabled();
    expect(screen.queryByText(/locatie is nog niet afgerond/)).not.toBeInTheDocument();
    expect(screen.queryByText(/locaties zijn nog niet afgerond/)).not.toBeInTheDocument();
  });
});
