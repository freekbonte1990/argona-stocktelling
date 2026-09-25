// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalysisPage } from "./AnalysisPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * Sprint 2 (Historical Count Analysis) §17 (UI-tests): een COMPLETED sessie
 * moet de nieuwe "Analyse telling" openen, de kern-KPI's moeten renderen, de
 * productgroep-/obsolete-filters moeten de detaillijst filteren, en er mag
 * NERGENS een telactie (tellen/bevestigen/afronden/exporteren) op dit
 * scherm staan — dit is strikt een alleen-lezen historische view. Zelfde
 * testpatroon (echte IndexedDB via fake-indexeddb + de echte
 * application/container-services) als ReviewPage.test.tsx.
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
  previousCount: 2,
});
const zonnepaneel = makeArticle({
  articleNumber: "ZON1",
  description: "Zonnepaneel 300W",
  productGroup: "Zonnepanelen",
  costPrice: 50,
  previousCount: 5,
  stockClassification: "OBSOLETE",
});

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
    db.historicalSheets,
    db.stockHistoryEntries,
    db.finalizedSessionResults,
  ]) {
    await table.clear();
  }

  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([batterij, zonnepaneel]);
  session = await countSessionService.startSession("office-1", "MONTHLY");
  await countingService.recordCount({
    session,
    articleId: batterij.id,
    locationId: "office-1:loc-1",
    quantity: 4, // was 2 -> verschil +2, +€200
  });
  await countingService.recordCount({
    session,
    articleId: zonnepaneel.id,
    locationId: "office-1:loc-1",
    quantity: 5, // ongewijzigd
  });
  await countingService.completeLocation(session.id, "office-1:loc-1");
  await countSessionService.completeSession(session.id);
});

async function waitUntilLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument();
  });
}

describe("AnalysisPage — Analyse telling (Sprint 2, alleen-lezen historische view)", () => {
  it("opent voor een COMPLETED sessie en toont de kern-KPI's", async () => {
    render(<AnalysisPage sessionId={session.id} onOpenArticle={() => {}} onOpenComparison={() => {}} />);
    await waitUntilLoaded();

    expect(screen.getByText("Alleen-lezen")).toBeInTheDocument();
    // Voorraadwaarde: batterij 4*100=400, zonnepaneel 5*50=250 -> €650.
    expect(screen.getByText("€ 650,00")).toBeInTheDocument();
    expect(screen.getAllByText("Batterijen").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Zonnepanelen").length).toBeGreaterThan(0);
  });

  it("klikken op een productgroep filtert de detaillijst tot die groep", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage sessionId={session.id} onOpenArticle={() => {}} onOpenComparison={() => {}} />);
    await waitUntilLoaded();

    const groupButton = screen.getByRole("button", { name: "Batterijen" });
    await user.click(groupButton);

    const list = screen.getByText("1 van 2 artikelen");
    expect(list).toBeInTheDocument();
    // BAT1 heeft ook een verschil (+2, €200) en staat dus ook in het
    // "Grootste afwijkingen"-blok — scope daarom expliciet tot de
    // detaillijst zelf om die sectie niet per ongeluk mee te tellen.
    const articleList = document.getElementById("analysis-article-list");
    if (!articleList) throw new Error("detaillijst-container niet gevonden");
    expect(within(articleList).getByText(/BAT1/)).toBeInTheDocument();
    expect(within(articleList).queryByText(/ZON1/)).not.toBeInTheDocument();
  });

  it("de 'Obsolete'-chip filtert de detaillijst tot obsolete artikelen", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage sessionId={session.id} onOpenArticle={() => {}} onOpenComparison={() => {}} />);
    await waitUntilLoaded();

    const obsoleteChip = screen.getByRole("button", { name: "Obsolete" });
    await user.click(obsoleteChip);

    // ZON1 staat sowieso ook (ongefilterd) in het "Obsolete voorraad"-blok,
    // en BAT1 (met een verschil van +2) staat ook in "Grootste afwijkingen"
    // — scope daarom expliciet tot de detaillijst zelf.
    const articleList = document.getElementById("analysis-article-list");
    if (!articleList) throw new Error("detaillijst-container niet gevonden");
    expect(within(articleList).getByText(/ZON1/)).toBeInTheDocument();
    expect(within(articleList).queryByText(/BAT1/)).not.toBeInTheDocument();
  });

  it("bevat NERGENS een telactie — geen tellen/bevestigen/afronden/exporteren op dit alleen-lezen scherm", async () => {
    render(<AnalysisPage sessionId={session.id} onOpenArticle={() => {}} onOpenComparison={() => {}} />);
    await waitUntilLoaded();

    expect(screen.queryByText("Telling afronden")).not.toBeInTheDocument();
    expect(screen.queryByText("Exporteren naar Excel")).not.toBeInTheDocument();
    expect(screen.queryByText(/Niet aanwezig/)).not.toBeInTheDocument();
    expect(screen.queryByText(/voorraad 0/)).not.toBeInTheDocument();
  });
});
