// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomePage } from "./HomePage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countSessionService } from "../../application/container";
import type { Article, Office } from "../../domain/types";
import { formatDate } from "../../shared/format";

/**
 * Sessielogica-fix: "Telling hervatten"/"Nieuwe telling" op het hoofdscherm.
 * Zelfde testpatroon (echte IndexedDB via fake-indexeddb) als de andere
 * paginatests, bv. LocationOverviewPage.test.tsx.
 */

const office: Office = {
  id: "office-1",
  name: "Lokeren",
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

const articleA1 = makeArticle({ articleNumber: "A1" });
const articleA2 = makeArticle({ articleNumber: "A2" });

beforeEach(async () => {
  for (const table of [db.offices, db.articles, db.sessions, db.countEntries, db.assignments, db.appState]) {
    await table.clear();
  }
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleA1, articleA2]);
});

function renderHomePage(overrides: Partial<Parameters<typeof HomePage>[0]> = {}) {
  return render(
    <HomePage
      officeId="office-1"
      onStartNewSession={() => {}}
      onResumeSession={() => {}}
      onOpenArticles={() => {}}
      onOpenSettings={() => {}}
      onSwitchOffice={() => {}}
      onImportNewOffice={() => {}}
      onOpenReview={() => {}}
      onCancelSession={async () => {}}
      {...overrides}
    />,
  );
}

async function waitUntilOfficeLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Kantoor wordt geladen...")).not.toBeInTheDocument();
  });
}

describe("HomePage — sessielogica-fix", () => {
  it("toont geen 'Lopende telling'-blok wanneer er geen actieve sessie is, en 'Nieuwe telling' navigeert meteen", async () => {
    const user = userEvent.setup();
    const onStartNewSession = vi.fn();
    renderHomePage({ onStartNewSession });
    await waitUntilOfficeLoaded();

    expect(screen.queryByText("Lopende telling")).not.toBeInTheDocument();
    await user.click(screen.getByText("Nieuwe telling"));

    expect(onStartNewSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Er loopt al een telling")).not.toBeInTheDocument();
  });

  it("toont een duidelijk 'Lopende telling'-blok met type, voortgang en startdatum", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    await countingRepository.saveCountEntry({
      id: `${session.id}:office-1:A1:office-1:loc-1`,
      sessionId: session.id,
      articleId: "office-1:A1",
      locationId: "office-1:loc-1",
      quantity: 3,
      counted: true,
      countedAt: new Date().toISOString(),
      note: null,
      resolution: "COUNTED",
    });

    renderHomePage();
    await waitUntilOfficeLoaded();

    expect(await screen.findByText("Lopende telling")).toBeInTheDocument();
    expect(screen.getByText("Maandtelling")).toBeInTheDocument();
    // `useCountEntries` laadt asynchroon na de eerste render (waarin de kaart
    // al met de nog-lege standaardwaarde [] toont) — wacht daarom expliciet
    // tot de echte voortgang (1/2) verschijnt i.p.v. een synchrone check.
    expect(
      await screen.findByText(
        (_content, element) => element?.textContent === "1 / 2 artikelen afgewerkt",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Gestart op ${formatDate(session.startedAt)}`),
    ).toBeInTheDocument();
  });

  it("'Telling hervatten' in het lopende-telling-blok roept onResumeSession rechtstreeks aan, zonder dialoog", async () => {
    const user = userEvent.setup();
    const onResumeSession = vi.fn();
    await countSessionService.startSession("office-1", "MONTHLY");
    renderHomePage({ onResumeSession });
    await waitUntilOfficeLoaded();

    const card = (await screen.findByText("Lopende telling")).closest(".card") as HTMLElement;
    await user.click(within(card).getByText("Telling hervatten"));

    expect(onResumeSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Er loopt al een telling")).not.toBeInTheDocument();
  });

  it("klik op 'Nieuwe telling' bij een actieve sessie toont de waarschuwingsdialoog i.p.v. direct te navigeren", async () => {
    const user = userEvent.setup();
    const onStartNewSession = vi.fn();
    await countSessionService.startSession("office-1", "MONTHLY");
    renderHomePage({ onStartNewSession });
    await waitUntilOfficeLoaded();

    await user.click(screen.getByText("Nieuwe telling"));

    expect(onStartNewSession).not.toHaveBeenCalled();
    expect(await screen.findByText("Er loopt al een telling")).toBeInTheDocument();
    expect(screen.getByText("Er loopt momenteel een maandtelling voor Lokeren.")).toBeInTheDocument();
  });

  it("'Telling hervatten' in de waarschuwingsdialoog hervat rechtstreeks", async () => {
    const user = userEvent.setup();
    const onResumeSession = vi.fn();
    await countSessionService.startSession("office-1", "MONTHLY");
    renderHomePage({ onResumeSession });
    await waitUntilOfficeLoaded();

    await user.click(screen.getByText("Nieuwe telling"));
    const dialog = (await screen.findByText("Er loopt al een telling")).closest(".modal-card") as HTMLElement;
    await user.click(within(dialog).getByText("Telling hervatten"));

    expect(onResumeSession).toHaveBeenCalledTimes(1);
  });

  it("'Telling annuleren' (via 'Nieuwe telling') -> bevestigen roept onCancelSession aan met het juiste sessieId en sluit de dialoog", async () => {
    const user = userEvent.setup();
    const onCancelSession = vi.fn().mockResolvedValue(undefined);
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    renderHomePage({ onCancelSession });
    await waitUntilOfficeLoaded();

    await user.click(screen.getByText("Nieuwe telling"));
    // Zowel de "Lopende telling"-kaart (aanvulling, zie hieronder) als deze
    // waarschuwingsdialoog tonen nu een "Telling annuleren"-knop — scope
    // daarom expliciet tot de dialoog.
    const warningDialog = (await screen.findByText("Er loopt al een telling")).closest(
      ".modal-card",
    ) as HTMLElement;
    await user.click(within(warningDialog).getByText("Telling annuleren"));

    expect(await screen.findByText("Telling annuleren?")).toBeInTheDocument();
    await user.click(screen.getByText("Ja, telling annuleren"));

    await waitFor(() => expect(onCancelSession).toHaveBeenCalledWith(session.id));
    await waitFor(() => expect(screen.queryByText("Telling annuleren?")).not.toBeInTheDocument());
  });

  it(
    "aanvulling (\"een lopende telling moet je kunnen annuleren\"): de 'Lopende telling'-kaart heeft nu " +
      "ook rechtstreeks een 'Telling annuleren'-knop, zonder om te moeten via 'Nieuwe telling'",
    async () => {
      const user = userEvent.setup();
      const onCancelSession = vi.fn().mockResolvedValue(undefined);
      const session = await countSessionService.startSession("office-1", "MONTHLY");
      renderHomePage({ onCancelSession });
      await waitUntilOfficeLoaded();

      const card = (await screen.findByText("Lopende telling")).closest(".card") as HTMLElement;
      await user.click(within(card).getByText("Telling annuleren"));

      // Rechtstreeks naar de bevestigingsdialoog — nooit via "Er loopt al een telling".
      expect(screen.queryByText("Er loopt al een telling")).not.toBeInTheDocument();
      expect(await screen.findByText("Telling annuleren?")).toBeInTheDocument();

      await user.click(screen.getByText("Ja, telling annuleren"));
      await waitFor(() => expect(onCancelSession).toHaveBeenCalledWith(session.id));
      await waitFor(() => expect(screen.queryByText("Telling annuleren?")).not.toBeInTheDocument());
    },
  );

  it("'Terug' in de annuleerbevestiging sluit gewoon de dialoog (bereikbaar zonder de waarschuwing ooit gezien te hebben)", async () => {
    const user = userEvent.setup();
    await countSessionService.startSession("office-1", "MONTHLY");
    renderHomePage();
    await waitUntilOfficeLoaded();

    const card = (await screen.findByText("Lopende telling")).closest(".card") as HTMLElement;
    await user.click(within(card).getByText("Telling annuleren"));
    await screen.findByText("Telling annuleren?");

    await user.click(screen.getByText("Terug"));

    expect(screen.queryByText("Telling annuleren?")).not.toBeInTheDocument();
    expect(screen.queryByText("Er loopt al een telling")).not.toBeInTheDocument();
  });

  it("toont 'Vorige tellingen' compact/samengevouwen, en toont NERGENS geannuleerde tellingen in de UI (records blijven wel bestaan)", async () => {
    const completedSession = await countSessionService.startSession("office-1", "MONTHLY");
    for (const article of [articleA1, articleA2]) {
      await countingRepository.saveCountEntry({
        id: `${completedSession.id}:${article.id}:office-1:loc-1`,
        sessionId: completedSession.id,
        articleId: article.id,
        locationId: "office-1:loc-1",
        quantity: 1,
        counted: true,
        countedAt: new Date().toISOString(),
        note: null,
        resolution: "COUNTED",
      });
    }
    for (const location of office.locations) {
      await countingRepository.saveLocationSessionStatus({
        id: `${completedSession.id}:${location.id}`,
        sessionId: completedSession.id,
        locationId: location.id,
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
      });
    }
    await countSessionService.completeSession(completedSession.id);

    const cancelledSession = await countSessionService.startSession("office-1", "QUARTERLY");
    await countSessionService.cancelSession(cancelledSession.id);

    renderHomePage();
    await waitUntilOfficeLoaded();

    // Home/UI-fix: "Vorige tellingen" staat samengevouwen achter een
    // samenvatting met aantal — de rij zelf ("Maandtelling") komt pas na een
    // klik in beeld, maar mag (net als bij de vroegere geannuleerde-sessies
    // `<details>`) al wel in de DOM aanwezig zijn.
    expect(await screen.findByText("Vorige tellingen (1)")).toBeInTheDocument();
    expect(screen.getByText("Maandtelling")).toBeInTheDocument();

    // Geannuleerde tellingen mogen nergens in de zichtbare Home-UI opduiken.
    expect(screen.queryByText("Geannuleerde tellingen")).not.toBeInTheDocument();
    expect(screen.queryByText("Geannuleerd")).not.toBeInTheDocument();
    expect(screen.queryByText("Kwartaaltelling")).not.toBeInTheDocument();

    // Het CANCELLED-record zelf blijft gewoon bestaan (enkel de UI verbergt het).
    const allSessions = await countingRepository.getSessionsForOffice("office-1");
    expect(allSessions.some((s) => s.id === cancelledSession.id && s.status === "CANCELLED")).toBe(true);
  });
});
