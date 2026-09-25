// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComparisonPage } from "./ComparisonPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * Sprint 3 (Vergelijking tussen stocktellingen) §16 (UI-tests): A/B-selectors,
 * productgroepfilter, unchanged-filter, obsolete-candidate-filter, drilldown,
 * en NERGENS een tel-/mutatie-actie — zelfde testpatroon (echte IndexedDB via
 * fake-indexeddb + de echte application/container-services) als
 * AnalysisPage.test.tsx.
 */

const office: Office = {
  id: "office-1",
  name: "Antwerpen",
  baseDate: null,
  locations: [{ id: "office-1:loc-1", officeId: "office-1", number: 1, name: "Rek 1", active: true }],
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

const batterij = makeArticle({
  articleNumber: "BAT1",
  description: "Batterij 5kWh",
  productGroup: "Batterijen",
  costPrice: 100,
});
const zonnepaneel = makeArticle({
  articleNumber: "ZON1",
  description: "Zonnepaneel 300W",
  productGroup: "Zonnepanelen",
  costPrice: 50,
});

let session0: CountSession;
let session1: CountSession;
let session2: CountSession;

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
    db.historicalSheets,
    db.stockHistoryEntries,
    db.finalizedSessionResults,
  ]) {
    await table.clear();
  }

  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([batterij, zonnepaneel]);

  // Drie opeenvolgende afgeronde tellingen: BAT1 blijft overal 4 stuks
  // (opeenvolgend ongewijzigd -> obsolete-kandidaat vanaf de 3e telling),
  // ZON1 verandert pas bij de laatste telling (5 -> 8).
  async function complete(quantities: { bat: number; zon: number }) {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    await countingService.recordCount({
      session,
      articleId: batterij.id,
      locationId: "office-1:loc-1",
      quantity: quantities.bat,
    });
    await countingService.recordCount({
      session,
      articleId: zonnepaneel.id,
      locationId: "office-1:loc-1",
      quantity: quantities.zon,
    });
    await countingService.completeLocation(session.id, "office-1:loc-1");
    await countSessionService.completeSession(session.id);
    // Zie ComparisonService.test.ts: een kleine, echte vertraging voorkomt
    // identieke startedAt/completedAt-timestamps tussen snel na elkaar
    // afgeronde sessies, nodig voor een ondubbelzinnige chronologische
    // volgorde ("onmiddellijk voorafgaande telling").
    await new Promise((resolve) => setTimeout(resolve, 5));
    return session;
  }

  session0 = await complete({ bat: 4, zon: 5 });
  session1 = await complete({ bat: 4, zon: 5 });
  session2 = await complete({ bat: 4, zon: 8 });
});

async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
    expect(screen.queryByText("Bezig met vergelijken...")).not.toBeInTheDocument();
    expect(screen.getByText("Vergelijking per productgroep")).toBeInTheDocument();
  });
}

describe("ComparisonPage — Vergelijken (Sprint 3, alleen-lezen historische view)", () => {
  it("opent met default B = geopende sessie, A = onmiddellijk voorafgaande telling, en toont de hoofd-KPI's", async () => {
    render(<ComparisonPage sessionId={session2.id} onOpenArticle={() => {}} onOpenAnalysis={() => {}} />);
    await waitUntilLoaded();

    expect(screen.getByText("Alleen-lezen")).toBeInTheDocument();
    const selectA = screen.getByLabelText("Telling A") as HTMLSelectElement;
    const selectB = screen.getByLabelText("Telling B") as HTMLSelectElement;
    expect(selectB.value).toBe(session2.id);
    expect(selectA.value).toBe(session1.id);

    // Totale voorraadwaarde A (BAT1 4*100 + ZON1 5*50 = 650) vs B (4*100 + 8*50 = 800).
    // Scoped tot de "Totale voorraadwaarde"-tegelgroep: beide artikelen zijn
    // hier ACTIEF (geen obsolete voorraad), dus hetzelfde bedrag komt ook
    // terug bij "Normale voorraad" — bewust scopen om die dubbele match te
    // vermijden.
    const stockValueGroup = screen.getByText("Totale voorraadwaarde").closest(".summary-group") as HTMLElement;
    expect(within(stockValueGroup).getByText("€ 650,00")).toBeInTheDocument();
    expect(within(stockValueGroup).getByText("€ 800,00")).toBeInTheDocument();
  });

  it("de A/B-selectors laten enkel COMPLETED sessies van hetzelfde kantoor toe en kunnen vrij gewisseld worden", async () => {
    const user = userEvent.setup();
    render(<ComparisonPage sessionId={session2.id} onOpenArticle={() => {}} onOpenAnalysis={() => {}} />);
    await waitUntilLoaded();

    const selectA = screen.getByLabelText("Telling A") as HTMLSelectElement;
    const sessionOptions = within(selectA)
      .getAllByRole("option")
      .filter((o) => (o as HTMLOptionElement).value !== "");
    // Alle 3 COMPLETED sessies van dit kantoor staan in de lijst — enkel de
    // huidige telling B (session2) is hier disabled, om A === B te voorkomen.
    expect(sessionOptions).toHaveLength(3);
    expect(sessionOptions.find((o) => (o as HTMLOptionElement).value === session2.id)).toHaveProperty(
      "disabled",
      true,
    );

    await user.selectOptions(selectA, session0.id);
    await waitFor(() => expect((screen.getByLabelText("Telling A") as HTMLSelectElement).value).toBe(session0.id));
  });

  it("productgroepfilter beperkt de detaillijst tot die groep", async () => {
    const user = userEvent.setup();
    render(<ComparisonPage sessionId={session2.id} onOpenArticle={() => {}} onOpenAnalysis={() => {}} />);
    await waitUntilLoaded();

    const groupButton = screen.getByRole("button", { name: "Batterijen" });
    await user.click(groupButton);

    const detailList = document.getElementById("comparison-article-list");
    if (!detailList) throw new Error("detailtabel-container niet gevonden");
    expect(within(detailList).getByText(/BAT1/)).toBeInTheDocument();
    expect(within(detailList).queryByText(/ZON1/)).not.toBeInTheDocument();
  });

  it("het 'Ongewijzigd'-filter toont enkel artikelen met identieke snapshot-quantity", async () => {
    const user = userEvent.setup();
    render(<ComparisonPage sessionId={session2.id} onOpenArticle={() => {}} onOpenAnalysis={() => {}} />);
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "Ongewijzigd" }));

    const detailList = document.getElementById("comparison-article-list");
    if (!detailList) throw new Error("detailtabel-container niet gevonden");
    expect(within(detailList).getByText(/BAT1/)).toBeInTheDocument();
    expect(within(detailList).queryByText(/ZON1/)).not.toBeInTheDocument();
  });

  it("het 'Kandidaat obsolete'-filter toont enkel artikelen die minstens 3 opeenvolgende tellingen ongewijzigd zijn", async () => {
    const user = userEvent.setup();
    render(<ComparisonPage sessionId={session2.id} onOpenArticle={() => {}} onOpenAnalysis={() => {}} />);
    await waitUntilLoaded();

    // Ook rechtstreeks zichtbaar in de aparte "Kandidaten voor obsolete"-sectie.
    expect(screen.getByText("Kandidaten voor obsolete")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Kandidaat obsolete" }));
    const detailList = document.getElementById("comparison-article-list");
    if (!detailList) throw new Error("detailtabel-container niet gevonden");
    expect(within(detailList).getByText(/BAT1/)).toBeInTheDocument();
    expect(within(detailList).queryByText(/ZON1/)).not.toBeInTheDocument();
  });

  it("klikken op een artikel in de detaillijst roept onOpenArticle aan (drilldown)", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(
      <ComparisonPage
        sessionId={session2.id}
        onOpenArticle={(articleId) => opened.push(articleId)}
        onOpenAnalysis={() => {}}
      />,
    );
    await waitUntilLoaded();

    const detailList = document.getElementById("comparison-article-list");
    if (!detailList) throw new Error("detailtabel-container niet gevonden");
    const link = within(detailList).getByText(/BAT1/);
    await user.click(link);

    expect(opened).toEqual([batterij.id]);
  });

  it("bevat NERGENS een telactie — geen tellen/bevestigen/afronden/exporteren op dit alleen-lezen scherm", async () => {
    render(<ComparisonPage sessionId={session2.id} onOpenArticle={() => {}} onOpenAnalysis={() => {}} />);
    await waitUntilLoaded();

    expect(screen.queryByText("Telling afronden")).not.toBeInTheDocument();
    expect(screen.queryByText("Exporteren naar Excel")).not.toBeInTheDocument();
    expect(screen.queryByText(/Niet aanwezig/)).not.toBeInTheDocument();
  });

  it("de 'Analyse'-toggle roept onOpenAnalysis aan met de huidige telling B", async () => {
    const user = userEvent.setup();
    const openedAnalysis: string[] = [];
    render(
      <ComparisonPage
        sessionId={session2.id}
        onOpenArticle={() => {}}
        onOpenAnalysis={(sessionId) => openedAnalysis.push(sessionId)}
      />,
    );
    await waitUntilLoaded();

    await user.click(screen.getByRole("button", { name: "Analyse" }));
    expect(openedAnalysis).toEqual([session2.id]);
  });
});
