// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewPage } from "./ReviewPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import { sessionSnapshotName } from "../../domain/stockSnapshot";
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
    db.productCategories,
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
  it("toont '1 / 2 locaties afgerond' en '1 / 2 artikels afgewerkt', en toont i.p.v. een disabled 'Telling afronden' de knop 'Afronden met openstaande artikelen'", async () => {
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
    expect(screen.getByText("Artikelen afgewerkt")).toBeInTheDocument();

    // Melding noemt zowel de open locatie als het onopgeloste artikel.
    expect(screen.getByText(/1 locatie is nog niet afgerond/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rek 2" })).toBeInTheDocument();
    expect(screen.getByText(/Nog 1 artikel\(en\) in scope zijn niet/)).toBeInTheDocument();

    // Sticky-bottombalk (ReviewPage UX-fix): toont nooit een disabled
    // "Telling afronden" naast de uitzonderingsknop — zolang de telling
    // onvolledig is, is enkel de "Afronden met X openstaande artikelen"-knop
    // zichtbaar/beschikbaar.
    expect(screen.queryByRole("button", { name: "Telling afronden" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Afronden met 1 openstaande artikelen" }),
    ).toBeInTheDocument();
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

/**
 * Aanvulling: "Afronden met openstaande artikels" — de uitzonderingsflow
 * naast de strikte afronding hierboven.
 */
describe("ReviewPage — 'Afronden met openstaande artikels' (aanvulling)", () => {
  it("toont de secundaire knop zolang de telling onvolledig is, en verbergt ze zodra alles klaar is", async () => {
    await countingService.recordCount({
      session,
      articleId: articleM1.id,
      locationId: office.locations[0].id,
      quantity: 3,
    });
    // M2 blijft ongeteld, locatie 2 blijft open.
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

    expect(await screen.findByText("Afronden met 1 openstaande artikelen")).toBeInTheDocument();

    // Volledig afronden -> de secundaire knop is niet meer nodig/zichtbaar.
    await countingService.confirmAbsent(session, articleM2.id);
    await countingService.completeLocation(session.id, office.locations[1].id);
    await waitFor(() => {
      expect(screen.queryByText(/Afronden met \d+ openstaande artikelen/)).not.toBeInTheDocument();
    });
  });

  it("klikken toont een bevestigingsdialoog met het aantal niet-getelde artikelen en niet-afgeronde locaties", async () => {
    const user = userEvent.setup();
    await countingService.recordCount({
      session,
      articleId: articleM1.id,
      locationId: office.locations[0].id,
      quantity: 3,
    });
    // M2 blijft ongeteld. Locatie 1 wordt afgerond, locatie 2 blijft open.
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

    await user.click(await screen.findByText("Afronden met 1 openstaande artikelen"));

    expect(await screen.findByText("Afronden met openstaande artikels?")).toBeInTheDocument();
    expect(screen.getByText("1 artikel(en) worden overgenomen.")).toBeInTheDocument();
    expect(screen.getByText("1 locatie(s) niet afgerond.")).toBeInTheDocument();
  });

  it("'Afronden en vorige voorraad overnemen' rondt de sessie af ondanks openstaande artikels/locaties", async () => {
    const user = userEvent.setup();
    let completed = false;
    await countingService.recordCount({
      session,
      articleId: articleM1.id,
      locationId: office.locations[0].id,
      quantity: 3,
    });

    render(
      <ReviewPage
        sessionId={session.id}
        onRecount={() => {}}
        onCompleted={() => (completed = true)}
        onOpenLocationOverview={() => {}}
        onOpenLocation={() => {}}
      />,
    );
    await waitUntilLoaded();

    await user.click(await screen.findByText("Afronden met 1 openstaande artikelen"));
    await user.click(await screen.findByText("Afronden en vorige voorraad overnemen"));

    await waitFor(() => expect(completed).toBe(true));
    const completedSession = await countingRepository.getSession(session.id);
    expect(completedSession?.status).toBe("COMPLETED");
    expect(completedSession?.completedAt).not.toBeNull();
  });

  it("'Terug naar telling' sluit de dialoog zonder iets af te ronden", async () => {
    const user = userEvent.setup();
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

    await user.click(await screen.findByText("Afronden met 2 openstaande artikelen"));
    await user.click(await screen.findByText("Terug naar telling"));

    expect(screen.queryByText("Afronden met openstaande artikels?")).not.toBeInTheDocument();
    const stillActive = await countingRepository.getSession(session.id);
    expect(stillActive?.status).toBe("ACTIVE");
  });

  it("een openstaande locatie blokkeert de uitzonderlijke afronding niet, ook als alle artikelen wel geteld zijn", async () => {
    const user = userEvent.setup();
    await countingService.recordCount({
      session,
      articleId: articleM1.id,
      locationId: office.locations[0].id,
      quantity: 3,
    });
    await countingService.confirmAbsent(session, articleM2.id);
    // Beide artikelen zijn opgelost, maar GEEN enkele locatie is afgerond.

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

    await user.click(await screen.findByText("Afronden met 0 openstaande artikelen"));
    expect(screen.getByText("0 artikel(en) worden overgenomen.")).toBeInTheDocument();
    expect(screen.getByText("2 locatie(s) niet afgerond.")).toBeInTheDocument();
    await user.click(await screen.findByText("Afronden en vorige voorraad overnemen"));

    const completedSession = await countingRepository.getSession(session.id);
    expect(completedSession?.status).toBe("COMPLETED");
  });
});

describe(
  "ReviewPage — sorteren (aanvulling: \"in de controle van de maandtelling moet je ook kunnen sorteren " +
    "op: verschil bedrag (hoog naar laag), kostprijs (hoog naar laag), verschil aantal (hoog naar laag)\")",
  () => {
    it("sorteert de artikelrijen op 'Verschil bedrag (hoog → laag)' via de dropdown", async () => {
      const user = userEvent.setup();
      // M1: kostprijs 1, telling 3 t.o.v. vorige 0 -> verschil +3 -> +3 €.
      // M2: kostprijs 5, telling 4 t.o.v. vorige 0 -> verschil +4 -> +20 € (hoogste bedrag, ondanks lager aantal).
      await countingRepository.saveArticles([
        { ...articleM1, costPrice: 1 },
        { ...articleM2, costPrice: 5 },
      ]);
      await countingService.recordCount({
        session,
        articleId: articleM1.id,
        locationId: office.locations[0].id,
        quantity: 3,
      });
      await countingService.recordCount({
        session,
        articleId: articleM2.id,
        locationId: office.locations[0].id,
        quantity: 4,
      });

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

      function descriptionOrder(): string[] {
        return screen
          .getAllByText(/artikel$/i, { selector: ".review-row__description" })
          .map((el) => el.textContent ?? "");
      }

      await user.selectOptions(screen.getByLabelText("Sorteren"), "Verschil bedrag (hoog → laag)");
      await waitFor(() => {
        expect(descriptionOrder()).toEqual(["Tweede artikel", "Eerste artikel"]);
      });

      await user.selectOptions(screen.getByLabelText("Sorteren"), "Verschil aantal (hoog → laag)");
      await waitFor(() => {
        // M2 heeft het hoogste verschil-AANTAL (+4 vs +3), ook al staat het bij bedrag hierboven.
        expect(descriptionOrder()).toEqual(["Tweede artikel", "Eerste artikel"]);
      });

      await user.selectOptions(screen.getByLabelText("Sorteren"), "Kostprijs (hoog → laag)");
      await waitFor(() => {
        expect(descriptionOrder()).toEqual(["Tweede artikel", "Eerste artikel"]);
      });

      await user.selectOptions(screen.getByLabelText("Sorteren"), "Standaard volgorde");
      await waitFor(() => {
        expect(descriptionOrder()).toEqual(["Eerste artikel", "Tweede artikel"]);
      });
    });
  },
);

describe(
  "ReviewPage — vergelijken met een willekeurig gekozen telling (aanvulling: \"je moet hier ook kunnen " +
    "kiezen om te vergelijken met een willekeurig gekozen telling (kiezen uit een dropdown menu)\")",
  () => {
    it("toont geen vergelijk-dropdown zolang er geen enkele afgeronde sessie bestaat om mee te vergelijken", async () => {
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
      expect(screen.queryByText("Vergelijken met")).not.toBeInTheDocument();
    });

    it("vergelijkt standaard met Article.previousCount, en kan overschakelen naar een eerder gekozen afgeronde sessie", async () => {
      const user = userEvent.setup();

      // Data-integriteit-sprint §3: sinds `completeSession` zelf finaliseert
      // (i.p.v. pas bij Excel-export), wordt `Article.previousCount` meteen
      // bijgewerkt naar de laatst AFGERONDE, volledig getelde sessie — niet
      // pas na een export/herimport-cyclus. Om toch een zinvol onderscheid
      // te kunnen testen tussen "standaard" (Article.previousCount, van de
      // MEEST RECENTE afgeronde sessie) en "een willekeurig GEKOZEN andere
      // afgeronde sessie", bouwen we hier TWEE eerder afgeronde sessies op
      // met een verschillend resultaat voor M1.

      // Slechts één ACTIVE sessie per kantoor toegestaan — de sessie uit
      // beforeEach annuleren zodat we hier zelf oudere afgeronde sessies
      // kunnen opbouwen vóór de sessie die we effectief gaan controleren.
      await countSessionService.cancelSession(session.id);

      // Oudste afgeronde sessie: M1 werd toen op 1 geteld.
      const oldestSession = await countSessionService.startSession("office-1", "QUARTERLY");
      await countingService.recordCount({
        session: oldestSession,
        articleId: articleM1.id,
        locationId: office.locations[0].id,
        quantity: 1,
      });
      await countingService.confirmAbsent(oldestSession, articleM2.id);
      await countingService.completeLocation(oldestSession.id, office.locations[0].id);
      await countingService.completeLocation(oldestSession.id, office.locations[1].id);
      await countSessionService.completeSession(oldestSession.id);

      // Meer recente afgeronde sessie: M1 werd toen op 2 geteld — dit wordt
      // meteen de nieuwe `Article.previousCount` (2), niet meer 1.
      const olderSession = await countSessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session: olderSession,
        articleId: articleM1.id,
        locationId: office.locations[0].id,
        quantity: 2,
      });
      await countingService.confirmAbsent(olderSession, articleM2.id);
      await countingService.completeLocation(olderSession.id, office.locations[0].id);
      await countingService.completeLocation(olderSession.id, office.locations[1].id);
      await countSessionService.completeSession(olderSession.id);

      // De sessie die nu effectief gecontroleerd wordt: M1 nu op 3 geteld.
      const currentSession = await countSessionService.startSession("office-1", "MONTHLY");
      await countingService.recordCount({
        session: currentSession,
        articleId: articleM1.id,
        locationId: office.locations[0].id,
        quantity: 3,
      });

      render(
        <ReviewPage
          sessionId={currentSession.id}
          onRecount={() => {}}
          onCompleted={() => {}}
          onOpenLocationOverview={() => {}}
          onOpenLocation={() => {}}
        />,
      );
      await waitUntilLoaded();

      // Standaard: vergelijkt met Article.previousCount (2, van de meest
      // recente afgeronde sessie `olderSession`) -> verschil +1.
      // Net als de vergelijk-dropdown hieronder: `officeArticles` (met de
      // bijgewerkte `previousCount`) komt uit een eigen live query die de
      // "Bezig met laden..."-gate niet blokkeert (die valt terug op een lege
      // lijst zolang de query nog loopt) — dus expliciet afwachten i.p.v.
      // aannemen dat dit al synchroon met `waitUntilLoaded()` klaarstaat.
      await waitFor(() => {
        expect(screen.getAllByText("Vorige telling").length).toBeGreaterThan(0);
        expect(screen.getByText("+1", { selector: ".review-row__figure-value" })).toBeInTheDocument();
      });

      // `comparisonSessions` komt uit een aparte live query (useSessionsForOffice)
      // dan degene die "Bezig met laden..." bepaalt — die kan nog even
      // achterlopen na `waitUntilLoaded()`. `findByLabelText` wacht dit netjes
      // af i.p.v. te veronderstellen dat de dropdown er al synchroon staat
      // (anders racy, machine-afhankelijk: bleek in de praktijk op een echte
      // Windows-omgeving soms nog niet bijgewerkt te zijn op dit punt).
      const select = await screen.findByLabelText("Vergelijken met");
      await user.selectOptions(select, sessionSnapshotName(oldestSession));

      // Nu vergeleken met de oudste sessie (M1 toen op 1) i.p.v. Article.previousCount (2) -> verschil +2.
      await waitFor(() => {
        expect(screen.queryByText("Vorige telling")).not.toBeInTheDocument();
      });
      expect(screen.getAllByText(sessionSnapshotName(oldestSession)).length).toBeGreaterThan(0);
      expect(screen.getByText("+2", { selector: ".review-row__figure-value" })).toBeInTheDocument();
    });
  },
);
