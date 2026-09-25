// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CountingPage } from "./CountingPage";
import { db } from "../../adapters/storage/db";
import { countingRepository, countingService, countSessionService } from "../../application/container";
import type { Article, CountSession, Office } from "../../domain/types";

/**
 * v0.2.1-hotfix — de blokkerende regressie zelf, maar dan op de plek waar
 * de bug écht zat: `defaultPool` op het telscherm. Dit test bewust MET de
 * echte IndexedDB-laag (via fake-indexeddb) en de echte
 * `application/container`-services, niet met gemockte props — anders test
 * je enkel dat de component doet wat je erin stopt, niet dat "Tellen" vanuit
 * Review daadwerkelijk een teloplossing biedt voor een artikel dat hier
 * (op déze locatie) nog nergens gekend is.
 *
 * Reproductie van de bug: locatie 1 is NIET in "learning mode" (M1 is er al
 * gekend/geteld), dus `knownAtLocation` bestaat uit enkel M1. Een tweede
 * artikel M2, dat nergens een CountEntry of ArticleLocationAssignment heeft,
 * valt daardoor buiten `defaultPool` — vóór de fix verscheen M2 dan nergens
 * op het scherm, ook niet met `focusArticleId`.
 */

function makeArticle(overrides: Partial<Article>): Article {
  return {
    id: `office-1:${overrides.articleNumber}`,
    officeId: "office-1",
    articleNumber: "ART",
    officialArticleNumber: null,
    idType: null,
    description: "Test artikel",
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

const articleM1 = makeArticle({ articleNumber: "M1", description: "Sigen BAT 8" });
const articleM2 = makeArticle({ articleNumber: "M2", description: "Nooit geteld artikel" });

let session: CountSession;

beforeEach(async () => {
  // Elke test start met een lege database (dezelfde gedeelde singleton die
  // CountingPage/container.ts ook gebruiken — vandaar geen eigen AppDatabase-naam).
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

  // M1 al geteld op locatie 1 -> locatie 1 is NIET (meer) in "learning mode",
  // en M2 heeft nergens een entry of assignment -> exact de bug-situatie.
  await countingService.recordCount({
    session,
    articleId: articleM1.id,
    locationId: office.locations[0].id,
    quantity: 3,
  });
});

describe("CountingPage — 'Tellen' op een artikel zonder bestaande CountEntry (v0.2.1-hotfix)", () => {
  it("toont het gefocuste artikel ook wanneer het hier nog geen entry/verwachting heeft, en laat het meteen tellen", async () => {
    const user = userEvent.setup();
    render(
      <CountingPage sessionId={session.id} locationId={office.locations[0].id} focusArticleId={articleM2.id} />,
    );

    // Zonder de fix zou M2 hier nooit verschijnen (buiten defaultPool).
    const card = await waitFor(() => {
      const description = screen.getByText("Nooit geteld artikel");
      return description.closest(".article-card") as HTMLElement;
    });
    expect(card).toBeTruthy();

    // Rechtstreeks vanuit dit scherm de hoeveelheid ingeven en "Geteld" kiezen.
    const input = within(card).getByPlaceholderText("0");
    await user.type(input, "7");
    await user.click(within(card).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      const entry = entries.find(
        (e) => e.articleId === articleM2.id && e.locationId === office.locations[0].id,
      );
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(7);
    });
  });

  it("blijft het al-gekende artikel (M1) tonen naast het nieuw gefocuste artikel", async () => {
    render(
      <CountingPage sessionId={session.id} locationId={office.locations[0].id} focusArticleId={articleM2.id} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Nooit geteld artikel")).toBeInTheDocument();
    });
    expect(screen.getByText("Sigen BAT 8")).toBeInTheDocument();
  });
});

describe("CountingPage — labels en visueel onderscheid (mobile/tablet UX-fix)", () => {
  it("toont '+ Bestaand artikel opzoeken' en '+ Nieuw artikel gevonden' als visueel gelijkwaardige secundaire acties (geen tekstlinkje meer tegenover een volwaardige knop)", async () => {
    render(<CountingPage sessionId={session.id} locationId={office.locations[0].id} />);
    // v0.3 §3: de standaardweergave is nu "Nog te tellen", die M1 (al hier
    // geteld in beforeEach) NIET toont — wacht daarom op een signaal dat
    // filter-onafhankelijk is (de knoppen staan altijd op het scherm) i.p.v.
    // op M1's omschrijving.
    await screen.findByRole("button", { name: "+ Nieuw artikel gevonden" });

    expect(screen.queryByText("+ Ander artikel tellen")).not.toBeInTheDocument();

    const lookupButton = screen.getByRole("button", { name: "+ Bestaand artikel opzoeken" });
    expect(lookupButton).toHaveClass("big-button", "big-button--secondary");
    expect(lookupButton).not.toHaveClass("text-link-button");

    const newArticleButton = screen.getByRole("button", { name: "+ Nieuw artikel gevonden" });
    expect(newArticleButton).toHaveClass("big-button", "big-button--secondary");
  });
});

describe("CountingPage — '+ Nieuw artikel gevonden' (v0.2.1 correctieronde §3B)", () => {
  it("maakt een nieuw artikel aan, koppelt de huidige locatie en telt het meteen — verschijnt in Review", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={office.locations[0].id} />);

    // v0.3 §3: standaardweergave is nu "Nog te tellen" (M1, al hier geteld,
    // is dan niet zichtbaar) — wacht op een filter-onafhankelijk signaal.
    await screen.findByRole("button", { name: "+ Nieuw artikel gevonden" });

    await user.click(screen.getByRole("button", { name: "+ Nieuw artikel gevonden" }));
    const modal = screen.getByText("Nieuw artikel gevonden").closest(".modal-card") as HTMLElement;
    expect(within(modal).getByText(/Rek 1/)).toBeInTheDocument();

    await user.type(within(modal).getByLabelText("Omschrijving *"), "Onverwacht onderdeel");
    await user.type(within(modal).getByLabelText("Productgroep *"), "Nieuw");
    await user.type(within(modal).getByLabelText("Eenheid *"), "stuk");
    await user.type(within(modal).getByLabelText("Getelde hoeveelheid *"), "4");
    await user.click(within(modal).getByRole("button", { name: "Opslaan en tellen" }));

    await waitFor(() => {
      expect(screen.queryByText("Nieuw artikel gevonden")).not.toBeInTheDocument();
    });

    const articles = await countingRepository.getArticles("office-1");
    const created = articles.find((a) => a.description === "Onverwacht onderdeel");
    expect(created).toBeDefined();
    expect(created?.idType).toBe("TIJDELIJK");
    expect(created?.articleNumber).toMatch(/^TMP-ANT-\d{4}$/);

    const assignments = await countingRepository.getArticleLocationAssignments("office-1");
    expect(
      assignments.some(
        (a) => a.articleId === created?.id && a.locationId === office.locations[0].id && a.active,
      ),
    ).toBe(true);

    const entries = await countingRepository.getCountEntries(session.id);
    const entry = entries.find((e) => e.articleId === created?.id);
    expect(entry?.counted).toBe(true);
    expect(entry?.quantity).toBe(4);

    // Buiten sessiescope (net als de bestaande "buiten scope"-toevoegingen) —
    // dat is precies wat domain/review.ts als "handmatige toevoeging" herkent.
    expect(session.articleIds.includes(created!.id)).toBe(false);
  });

  it("een expliciete hoeveelheid 0 is een geldige invoer", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={session.id} locationId={office.locations[0].id} />);
    // v0.3 §3: de standaardweergave is nu "Nog te tellen", die M1 (al hier
    // geteld in beforeEach) NIET toont — wacht daarom op een signaal dat
    // filter-onafhankelijk is (de knoppen staan altijd op het scherm) i.p.v.
    // op M1's omschrijving.
    await screen.findByRole("button", { name: "+ Nieuw artikel gevonden" });

    await user.click(screen.getByRole("button", { name: "+ Nieuw artikel gevonden" }));
    const modal = screen.getByText("Nieuw artikel gevonden").closest(".modal-card") as HTMLElement;

    await user.type(within(modal).getByLabelText("Omschrijving *"), "Leeg gevonden onderdeel");
    await user.type(within(modal).getByLabelText("Productgroep *"), "Nieuw");
    await user.type(within(modal).getByLabelText("Eenheid *"), "stuk");
    await user.type(within(modal).getByLabelText("Getelde hoeveelheid *"), "0");
    await user.click(within(modal).getByRole("button", { name: "Opslaan en tellen" }));

    await waitFor(() => {
      expect(screen.queryByText("Nieuw artikel gevonden")).not.toBeInTheDocument();
    });

    const articles = await countingRepository.getArticles("office-1");
    const created = articles.find((a) => a.description === "Leeg gevonden onderdeel");
    const entries = await countingRepository.getCountEntries(session.id);
    const entry = entries.find((e) => e.articleId === created?.id);
    expect(entry?.counted).toBe(true);
    expect(entry?.quantity).toBe(0);
  });
});

describe("CountingPage — automatisch locatie afronden (aanvulling: \"als alle artikels binnen een locatie zijn geteld mag je die als afgerond zien\")", () => {
  it("rondt de locatie automatisch af zodra het LAATSTE openstaande artikel geteld wordt, zonder de handmatige knop", async () => {
    const user = userEvent.setup();
    const loc2 = office.locations[1].id;
    // Beide artikelen krijgen een (nog niet geteld) stub-entry op locatie 2
    // binnen de BESTAANDE sessie uit de buitenste beforeEach — precies wat
    // `CountSessionService#buildInitialEntries` zou opleveren als beide
    // artikelen al bij sessiestart op deze locatie verwacht waren, zonder
    // een tweede ACTIVE sessie te moeten starten (mag maar één per kantoor).
    await countingRepository.saveCountEntries([
      {
        id: `${session.id}:${articleM1.id}:${loc2}`,
        sessionId: session.id,
        articleId: articleM1.id,
        locationId: loc2,
        quantity: null,
        counted: false,
        countedAt: null,
        note: null,
        resolution: "COUNTED",
      },
      {
        id: `${session.id}:${articleM2.id}:${loc2}`,
        sessionId: session.id,
        articleId: articleM2.id,
        locationId: loc2,
        quantity: null,
        counted: false,
        countedAt: null,
        note: null,
        resolution: "COUNTED",
      },
    ]);

    render(<CountingPage sessionId={session.id} locationId={loc2} />);
    await screen.findByRole("button", { name: "+ Nieuw artikel gevonden" });

    expect(
      (await countingRepository.getLocationSessionStatuses(session.id)).find((s) => s.locationId === loc2)?.status,
    ).not.toBe("COMPLETED");

    // Eerste artikel tellen — nog 1 openstaand, dus nog GEEN auto-afronding.
    // `fireEvent.change` i.p.v. `user.type`/`user.clear`: het scherm focust
    // en selecteert bij het laden zelf al automatisch het eerste NIET-getelde
    // artikel op alfabetische volgorde (`activateArticle`, via
    // requestAnimationFrame) — hier toevallig M2 ("Nooit geteld artikel"),
    // niet M1. Realistische, per-toets `user.type`-simulatie volgt de
    // ECHTE `document.activeElement`, dus als die achtergrond-rAF net dan
    // afvuurt, komt de getypte toets op het verkeerde veld terecht (een
    // race, machine-afhankelijk qua timing). `fireEvent.change` zet de
    // waarde rechtstreeks op dit specifieke DOM-element, ongeacht welk veld
    // toevallig focus heeft.
    const firstCard = screen.getByText("Sigen BAT 8").closest(".article-card") as HTMLElement;
    const firstInput = within(firstCard).getByPlaceholderText("0");
    fireEvent.change(firstInput, { target: { value: "5" } });
    await user.click(within(firstCard).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(session.id);
      expect(entries.find((e) => e.articleId === articleM1.id && e.locationId === loc2)?.counted).toBe(true);
    });
    expect(
      (await countingRepository.getLocationSessionStatuses(session.id)).find((s) => s.locationId === loc2)?.status,
    ).not.toBe("COMPLETED");

    // Tweede (laatste) artikel tellen — nu moet de locatie zichzelf afronden.
    // Zelfde reden als hierboven: rechtstreeks de waarde zetten, niet
    // afhankelijk van welk veld toevallig (nog) echte browserfocus heeft.
    const secondCard = screen.getByText("Nooit geteld artikel").closest(".article-card") as HTMLElement;
    const secondInput = within(secondCard).getByPlaceholderText("0");
    fireEvent.change(secondInput, { target: { value: "2" } });
    await user.click(within(secondCard).getByRole("button", { name: /Geteld/ }));

    await waitFor(async () => {
      const statuses = await countingRepository.getLocationSessionStatuses(session.id);
      expect(statuses.find((s) => s.locationId === loc2)?.status).toBe("COMPLETED");
    });
  });
});

/**
 * BUGFIX — functionele regressie: "+ Bestaand artikel opzoeken" wisselde het
 * knoplabel wel naar "Terug naar verwachte artikelen", maar de getoonde
 * lijst bleef in de praktijk dezelfde verwachte-locatie-artikelen tonen.
 * Root cause: de poolwissel (`officeArticles` i.p.v. `defaultPool`) klopte
 * al, maar `sortArticlesForLocation` zet artikelen die HIER verwacht worden
 * altijd vooraan — bij een kantoor met veel artikelen bleef de zichtbare
 * (bovenste) lijst dus onveranderd, ook al stonden de net gevonden
 * artikelen intussen wél ergens verderop tussen de resultaten. Dit
 * eigen, geïsoleerd kantoor (3 locaties) test de fix: artikelen die al aan
 * DEZE locatie gekoppeld zijn (verwacht of al geteld) horen niet langer als
 * zoekresultaat terug te komen, en de bestaande unexpected-location/
 * assignment-flow blijft ongewijzigd van toepassing.
 */
describe("CountingPage — 'Bestaand artikel opzoeken' doorzoekt écht het hele kantoor (bugfix)", () => {
  const officeId = "office-lookup-bugfix";
  const office3: Office = {
    id: officeId,
    name: "Gent",
    baseDate: null,
    locations: [1, 2, 3].map((n) => ({
      id: `${officeId}:loc-${n}`,
      officeId,
      number: n,
      name: `Rek ${n}`,
      active: true,
    })),
  };
  const loc1 = office3.locations[0].id;
  const loc3 = office3.locations[2].id;

  const articleRek1 = makeArticle({ articleNumber: "R1", description: "Artikel Rek1", productGroup: "GROEP" });
  const articleRek3 = makeArticle({ articleNumber: "R3", description: "Artikel Rek3", productGroup: "GROEP" });
  const articleZonderLocatie = makeArticle({
    articleNumber: "ZL",
    description: "Artikel Zonder Locatie",
    productGroup: "GROEP",
  });
  // Object.assign i.p.v. opnieuw makeArticle, zodat de office-id overeenkomt
  // (makeArticle hierboven hardcodet altijd "office-1" als officeId).
  for (const a of [articleRek1, articleRek3, articleZonderLocatie]) {
    (a as { officeId: string }).officeId = officeId;
    (a as { id: string }).id = `${officeId}:${a.articleNumber}`;
  }

  let lookupSession: CountSession;

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
    await countingRepository.saveOffice(office3);
    await countingRepository.saveArticles([articleRek1, articleRek3, articleZonderLocatie]);
    // Rek1 verwacht enkel articleRek1 -> knownAtLocation.length > 0 ->
    // isLearningMode is false, exact het scenario waarin de knop verschijnt.
    await countingRepository.saveArticleLocationAssignment({
      id: `${officeId}:${articleRek1.id}:${loc1}`,
      officeId,
      articleId: articleRek1.id,
      locationId: loc1,
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    await countingRepository.saveArticleLocationAssignment({
      id: `${officeId}:${articleRek3.id}:${loc3}`,
      officeId,
      articleId: articleRek3.id,
      locationId: loc3,
      active: true,
      lastSeenAt: new Date().toISOString(),
    });
    lookupSession = await countSessionService.startSession(officeId, "MONTHLY");
  });

  it("1. normale modus toont enkel het artikel dat op Rek 1 verwacht wordt", async () => {
    render(<CountingPage sessionId={lookupSession.id} locationId={loc1} />);

    await screen.findByText("Artikel Rek1");
    expect(screen.queryByText("Artikel Rek3")).not.toBeInTheDocument();
    expect(screen.queryByText("Artikel Zonder Locatie")).not.toBeInTheDocument();
  });

  it("2+3. 'Bestaand artikel opzoeken' vindt het Rek3-artikel en het artikel zonder locatie, maar toont het Rek1-artikel niet meer als zoekresultaat", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={lookupSession.id} locationId={loc1} />);

    await screen.findByText("Artikel Rek1");
    await user.click(screen.getByRole("button", { name: "+ Bestaand artikel opzoeken" }));
    await screen.findByRole("button", { name: "← Terug naar artikelen van deze locatie" });

    // Duidelijkheids-fix: de actieve modus staat nu ook expliciet aangeduid,
    // los van de knoptekst zelf.
    expect(screen.getByText(/Je doorzoekt nu alle artikelen van dit kantoor/)).toBeInTheDocument();

    // Beide "onverwachte" artikelen zijn nu wél vindbaar...
    const rek3Card = (await screen.findByText("Artikel Rek3")).closest(".article-card") as HTMLElement;
    const zlCard = (await screen.findByText("Artikel Zonder Locatie")).closest(".article-card") as HTMLElement;

    // ...met voldoende identificatie: artikelnummer + (indien van toepassing) bestaande locatie.
    expect(within(rek3Card).getByText("R3")).toBeInTheDocument();
    expect(within(rek3Card).getByText(/Al gekoppeld aan:.*Rek 3/)).toBeInTheDocument();
    expect(within(zlCard).getByText("ZL")).toBeInTheDocument();
    expect(within(zlCard).queryByText(/Al gekoppeld aan/)).not.toBeInTheDocument();

    // ...en het Rek1-artikel (al normaal zichtbaar) komt niet dubbel terug.
    expect(screen.queryByText("Artikel Rek1")).not.toBeInTheDocument();
  });

  it("4. tellen van een via-zoeken gevonden artikel op Rek 1 gebruikt de bestaande unexpected-location/assignment-flow", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={lookupSession.id} locationId={loc1} />);

    await screen.findByText("Artikel Rek1");
    await user.click(screen.getByRole("button", { name: "+ Bestaand artikel opzoeken" }));

    const rek3Card = (await screen.findByText("Artikel Rek3")).closest(".article-card") as HTMLElement;
    await user.type(within(rek3Card).getByPlaceholderText("0"), "6");
    await user.click(within(rek3Card).getByRole("button", { name: /Geteld/ }));

    // Bestaande, ongewijzigde confirmatiedialoog (zelfde tekst/flow als
    // elders in de app) — geen nieuwe businesslogica.
    expect(
      await screen.findByText(/Dit artikel werd normaal op Rek 3 verwacht, maar wordt nu op Rek 1 geteld\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ja, toevoegen" }));

    await waitFor(async () => {
      const entries = await countingRepository.getCountEntries(lookupSession.id);
      const entry = entries.find((e) => e.articleId === articleRek3.id && e.locationId === loc1);
      expect(entry?.counted).toBe(true);
      expect(entry?.quantity).toBe(6);
    });
    // Beide koppelingen (Rek 3 + Rek 1) blijven bestaan (spec: meerdere locaties toegestaan).
    const assignments = await countingRepository.getArticleLocationAssignments(officeId);
    expect(
      assignments.some((a) => a.articleId === articleRek3.id && a.locationId === loc3 && a.active),
    ).toBe(true);
    expect(
      assignments.some((a) => a.articleId === articleRek3.id && a.locationId === loc1 && a.active),
    ).toBe(true);
  });

  it("5. '← Terug naar artikelen van deze locatie' toont opnieuw enkel de Rek1-verwachte artikelen", async () => {
    const user = userEvent.setup();
    render(<CountingPage sessionId={lookupSession.id} locationId={loc1} />);

    await screen.findByText("Artikel Rek1");
    await user.click(screen.getByRole("button", { name: "+ Bestaand artikel opzoeken" }));
    await screen.findByText("Artikel Rek3");
    await screen.findByText("Artikel Zonder Locatie");

    await user.click(screen.getByRole("button", { name: "← Terug naar artikelen van deze locatie" }));

    await screen.findByText("Artikel Rek1");
    expect(screen.queryByText("Artikel Rek3")).not.toBeInTheDocument();
    // De modus-banner verdwijnt ook weer.
    expect(screen.queryByText(/Je doorzoekt nu alle artikelen van dit kantoor/)).not.toBeInTheDocument();
    expect(screen.queryByText("Artikel Zonder Locatie")).not.toBeInTheDocument();
    // Geen verwarrende gemengde toestand: het zoekveld is weer neutraal.
    expect(
      (screen.getByPlaceholderText("Zoek op artikelnummer of omschrijving...") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByRole("button", { name: "+ Bestaand artikel opzoeken" })).toBeInTheDocument();
  });
});
