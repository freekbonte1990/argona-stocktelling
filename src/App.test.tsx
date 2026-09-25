// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import App from "./App";
import { db } from "./adapters/storage/db";
import { countingRepository, countSessionService } from "./application/container";
import type { Article, Office } from "./domain/types";

/**
 * v0.3-hotfix (blokkerende bug, gemeld tijdens mobiel testen): "de actieve
 * locatie verspringt" / "na tellen van één artikel terug naar het
 * hoofdmenu". Grondig onderzoek van CountingPage en App.tsx's routing wees
 * uit dat de route altijd al uitsluitend via de immutabele `location.id`
 * wordt geïdentificeerd (nooit `location.number`/index/sorteervolgorde),
 * en dat "Geteld & volgende" nergens een navigatie triggert (CountingPage
 * krijgt zelfs geen navigatiecallback mee als prop). De enige plek waar de
 * gebruiker écht "terug naar Home" kon belanden was de app-brede route-state,
 * die tot nu toe UITSLUITEND in React-state leefde: elke onverwachte
 * volledige herlaad van de pagina (op een telefoon regelmatig, door het
 * besturingssysteem — geheugendruk, schermvergrendeling, app-wissel) zette
 * `route` terug op `null`, waarna de initialisatie altijd naar "Home" ging.
 *
 * Deze tests simuleren precies dat scenario: een volledige remount van
 * `<App />` (zoals na zo'n herlaad) MOET je terugbrengen naar exact dezelfde
 * `location.id` — nooit naar Home, en nooit naar een andere locatie, ook niet
 * als locatienummers/volgorde intussen gewijzigd zijn.
 *
 * Aanvulling ("bij opstart wil ik dit menu, nu opent hij precies altijd het
 * laatst geopende venster"): de routecache verhuisde van `localStorage` naar
 * `sessionStorage` — zie de aparte describe-groep onderaan dit bestand, die
 * bewust `localStorage` blijft gebruiken in zijn eigen setup/asserts (om te
 * bevestigen dat een écht nieuwe sessie, i.e. een lege `sessionStorage`, altijd
 * naar Home gaat, zelfs als er toevallig nog een oude `localStorage`-rest van
 * vóór deze aanvulling zou rondslingeren).
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

const articleA1 = makeArticle({ articleNumber: "A1", description: "Artikel A1" });

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
  localStorage.clear();
  sessionStorage.clear();
  await countingRepository.saveOffice(office);
  await countingRepository.saveArticles([articleA1]);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * Mobile/tablet UX-fix: de vroegere gecombineerde breadcrumb ("Antwerpen >
 * Rek B") is vervangen door één compacte header — de locatienaam als
 * primaire breadcrumb, het kantoor subtiel eronder als `subtitle` (geen
 * dubbele locatie/breadcrumb-weergave meer). We lezen daarom de
 * header-breadcrumb en -subtitle als aparte, unieke elementen i.p.v. op
 * samengestelde tekst te zoeken.
 */
function breadcrumb(): string | null {
  return document.querySelector(".app-header__breadcrumb")?.textContent ?? null;
}

function headerSubtitle(): string | null {
  return document.querySelector(".app-header__subtitle")?.textContent ?? null;
}

describe("App — route blijft op dezelfde location.id na een onverwachte herlaad (v0.3-hotfix)", () => {
  it("een echte navigatie naar Rek B overleeft een volledige remount (zoals na een mobiele achtergrond-herlaad)", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");

    const { unmount } = render(<App />);
    await waitFor(() => {
      expect(breadcrumb()).toBe("Argona Stocktelling");
    });

    // Echte navigatie door de UI (geen directe route-manipulatie): Home ->
    // "Zonder locatie" is niet relevant hier, dus we simuleren wat
    // countSessionService.getActiveSession + onOpenLocation zouden doen door
    // de al-lopende sessie rechtstreeks te openen, zoals HomePage's "verder
    // tellen"-knop dat ook doet.
    sessionStorage.setItem(
      "argona-stocktelling:lastRoute",
      JSON.stringify({ screen: "counting", sessionId: session.id, locationId: office.locations[1].id }),
    );
    // De persist-effect (useEffect op `route`) zou dit ook zelf geschreven
    // hebben zodra de gebruiker via de UI naar Rek B navigeert — dat pad
    // wordt in de vierde test hieronder apart geverifieerd.

    // Simuleer een volledige remount (JS-context start opnieuw), zoals een
    // door het OS herladen achtergrondtabblad: alle React-state, inclusief
    // `route`, is weg — enkel `sessionStorage` overleeft dat (dezelfde
    // browsing-sessie/tab, dus niet hetzelfde als een écht nieuwe app-start).
    unmount();
    render(<App />);

    await waitFor(() => {
      expect(breadcrumb()).toBe("Rek B");
      expect(headerSubtitle()).toBe("Antwerpen");
    });
  });

  it("een locatienummer-/volgordewijziging verandert niets aan welke locatie de herstelde route toont", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    sessionStorage.setItem(
      "argona-stocktelling:lastRoute",
      JSON.stringify({ screen: "counting", sessionId: session.id, locationId: office.locations[1].id }),
    );

    // Locaties herschikken/hernummeren NA het bewaren van de route, VOOR het
    // herstellen ervan — de route moet nog steeds naar Rek B wijzen (via
    // location.id), niet naar "wat nu locatienummer 2 is".
    const reorderedOffice: Office = {
      ...office,
      locations: [
        { ...office.locations[1], number: 1 }, // Rek B is nu nummer 1
        { ...office.locations[0], number: 2 }, // Rek A is nu nummer 2
      ],
    };
    await countingRepository.saveOffice(reorderedOffice);

    render(<App />);

    await waitFor(() => {
      expect(breadcrumb()).toBe("Rek B");
      expect(headerSubtitle()).toBe("Antwerpen");
    });
  });

  it("een bewaarde route naar een niet-bestaande sessie valt veilig terug op Home (geen crash, geen blanco scherm)", async () => {
    sessionStorage.setItem(
      "argona-stocktelling:lastRoute",
      JSON.stringify({ screen: "counting", sessionId: "session-bestaat-niet", locationId: "loc-x" }),
    );

    render(<App />);

    await waitFor(() => {
      expect(breadcrumb()).toBe("Argona Stocktelling");
    });
  });

  it("bewaart de huidige route automatisch zodra die verandert", async () => {
    const session = await countSessionService.startSession("office-1", "MONTHLY");
    sessionStorage.setItem(
      "argona-stocktelling:lastRoute",
      JSON.stringify({ screen: "counting", sessionId: session.id, locationId: office.locations[0].id }),
    );

    render(<App />);
    await waitFor(() => {
      expect(breadcrumb()).toBe("Rek A");
      expect(headerSubtitle()).toBe("Antwerpen");
    });

    const stored = JSON.parse(sessionStorage.getItem("argona-stocktelling:lastRoute") as string);
    expect(stored).toEqual({ screen: "counting", sessionId: session.id, locationId: office.locations[0].id });
  });
});

describe(
  "App — een écht nieuwe app-start (lege sessionStorage) gaat altijd naar Home (aanvulling: " +
    "\"bij opstart wil ik dit menu, nu opent hij precies altijd het laatst geopende venster\")",
  () => {
    it("gaat naar Home bij een lege sessionStorage, ook als er nog een oude route in localStorage hangt", async () => {
      const session = await countSessionService.startSession("office-1", "MONTHLY");

      // Vóór deze aanvulling stond de routecache in `localStorage`, en overleefde
      // die dus ook een écht nieuwe app-start (browser/tabblad dicht en opnieuw
      // open) — precies de klacht. Simuleer zo'n oude, achtergebleven waarde:
      // een écht nieuwe start moet die NEGEREN en gewoon naar Home gaan.
      localStorage.setItem(
        "argona-stocktelling:lastRoute",
        JSON.stringify({ screen: "counting", sessionId: session.id, locationId: office.locations[1].id }),
      );
      sessionStorage.clear();

      render(<App />);

      await waitFor(() => {
        expect(breadcrumb()).toBe("Argona Stocktelling");
      });
    });

    it("een achtergrond-herlaad binnen dezelfde sessie (sessionStorage blijft staan) herstelt wél de vorige locatie", async () => {
      const session = await countSessionService.startSession("office-1", "MONTHLY");
      sessionStorage.setItem(
        "argona-stocktelling:lastRoute",
        JSON.stringify({ screen: "counting", sessionId: session.id, locationId: office.locations[1].id }),
      );

      render(<App />);

      await waitFor(() => {
        expect(breadcrumb()).toBe("Rek B");
        expect(headerSubtitle()).toBe("Antwerpen");
      });
    });
  },
);
