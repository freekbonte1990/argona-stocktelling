// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalysisPage } from "./AnalysisPage";
import { SessionCorrectionPage } from "./SessionCorrectionPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

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
    db.productCategories,
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
    expect(screen.queryByText("Telling laden…")).not.toBeInTheDocument();
  });
}

describe("SessionCorrectionPage — telling corrigeren", () => {
  it("corrigeert het aantal; de telling blijft bestaan en de analyse toont de nieuwe waarde", async () => {
    const user = userEvent.setup();
    render(<SessionCorrectionPage sessionId={session.id} onDone={() => {}} />);
    await waitUntilLoaded();

    await user.type(screen.getByLabelText("Nieuw aantal voor BAT1"), "10");
    await user.click(screen.getByRole("button", { name: /Correcties opslaan \(1\)/ }));

    expect(await screen.findByText(/1 artikel\(s\) gecorrigeerd/)).toBeInTheDocument();
    expect(await db.sessions.get(session.id)).toBeDefined();
    const stored = await db.finalizedSessionResults.get(session.id);
    expect(stored?.snapshot.articles.find((a) => a.articleId === batterij.id)?.totalCount).toBe(10);
    expect(stored?.corrections).toHaveLength(1);
    expect((await db.articles.get(batterij.id))?.previousCount).toBe(10);

    const exportButton = screen.getByRole("button", { name: /Correcties exporteren \(1\)/ });
    expect(exportButton).toBeEnabled();
  });

  it("zoekt op artikelnummer en blokkeert opslaan zonder wijziging", async () => {
    const user = userEvent.setup();
    render(<SessionCorrectionPage sessionId={session.id} onDone={() => {}} />);
    await waitUntilLoaded();
    expect(screen.getByRole("button", { name: "Correcties opslaan" })).toBeDisabled();
    await user.type(screen.getByLabelText("Zoek artikel"), "ZON");
    expect(screen.queryByLabelText("Nieuw aantal voor BAT1")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Nieuw aantal voor ZON1")).toBeInTheDocument();
  });

  it("AnalysisPage toont de knop 'Telling corrigeren' en opent de correctie", async () => {
    const user = userEvent.setup();
    let opened: string | null = null;
    render(
      <AnalysisPage
        sessionId={session.id}
        onOpenArticle={() => {}}
        onOpenComparison={() => {}}
        onOpenCorrection={(id) => {
          opened = id;
        }}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Bezig met laden...")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Telling corrigeren" }));
    expect(opened).toBe(session.id);
  });
});
