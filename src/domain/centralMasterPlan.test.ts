import { describe, expect, it } from "vitest";
import { makeArticle, makeOffice } from "../application/services/centralHistoryTestUtils";
import {
  CATEGORY_KABELS,
  CATEGORY_LAMPEN,
  makeMaster,
  makeMasterArticle,
} from "../application/services/centralMasterTestUtils";
import type { CentralMasterStatus } from "./centralMasterFile";
import { planCentralMasterApply, type CentralMasterLocalState } from "./centralMasterPlan";
import type { Article, ArticleLocationAssignment } from "./types";

const NOW = "2026-10-06T08:00:00.000Z";

const emptyLocal = (): CentralMasterLocalState => ({
  office: undefined,
  articles: [],
  allArticles: [],
  assignments: [],
  categories: [],
});

function local(overrides: Partial<CentralMasterLocalState> = {}): CentralMasterLocalState {
  const articles = overrides.articles ?? [];
  return { ...emptyLocal(), allArticles: articles, ...overrides };
}

const managedStatus = (overrides: Partial<CentralMasterStatus> = {}): CentralMasterStatus => ({
  officeId: "damme",
  lastAttemptAt: NOW,
  lastSuccessAt: NOW,
  lastError: null,
  revision: "rev-0000",
  generatedAt: "2026-09-01T00:00:00.000Z",
  appliedAt: "2026-09-01T00:00:00.000Z",
  pendingRevision: null,
  articleIds: ["damme:A1", "damme:A2"],
  locationIds: ["damme:loc-1", "damme:loc-2"],
  categoryIds: [CATEGORY_KABELS.id, CATEGORY_LAMPEN.id],
  assignmentIds: [],
  ...overrides,
});

const tmpArticle = (): Article => ({
  ...makeArticle("damme", "TMP-DAM-0001"),
  idType: "TIJDELIJK",
  description: "Lokaal tijdelijk artikel",
  previousCount: 2,
});

describe("planCentralMasterApply — nieuw toestel (bootstrap)", () => {
  it("maakt kantoor, locaties, categorieën, artikelen en koppelingen aan; previousCount blijft leeg", () => {
    const plan = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW, selectOffice: true });
    expect(plan.office).toMatchObject({ id: "damme", name: "Damme", categoriesMigrated: true });
    expect(plan.office.locations.map((l) => l.id)).toEqual(["damme:loc-1", "damme:loc-2"]);
    expect(plan.articles.map((a) => a.id)).toEqual(["damme:A1", "damme:A2"]);
    expect(plan.articles.every((a) => a.previousCount === null)).toBe(true);
    expect(plan.articles[0]).toMatchObject({ costPrice: 2.5, categoryId: "cat-kabels", productGroup: "KABEL", assortmentActive: true });
    expect(plan.categories.map((c) => c.id)).toEqual(["cat-kabels", "cat-lampen"]);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.selectOffice).toBe(true);
    expect(plan.importMeta).toMatchObject({ officeId: "damme", sourceFileName: "Centrale master (rev-0001)" });
    expect(plan.status).toMatchObject({ revision: "rev-0001", appliedAt: NOW, pendingRevision: null, lastError: null });
    expect(plan.status.articleIds).toEqual(["damme:A1", "damme:A2"]);
    expect(plan.summary).toMatchObject({ articlesAdded: 2, locationsAdded: 2, categoriesWritten: 2 });
  });
});

describe("planCentralMasterApply — herhaald toepassen", () => {
  it("is idempotent: dezelfde master op een reeds toegepaste staat schrijft niets meer", () => {
    const first = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW });
    const second = planCentralMasterApply({
      master: makeMaster(),
      local: local({
        office: first.office,
        articles: first.articles,
        assignments: first.assignments,
        categories: first.categories,
      }),
      previousStatus: first.status,
      now: NOW,
    });
    expect(second.articles).toEqual([]);
    expect(second.assignments).toEqual([]);
    expect(second.categories).toEqual([]);
    expect(second.summary).toMatchObject({ articlesAdded: 0, articlesUpdated: 0, articlesUnchanged: 2, articlesDeactivated: 0 });
  });

  it("wijzigingen aan masterdata (omschrijving, kostprijs, frequentie, productgamma) worden overgenomen en raken previousCount/comment niet", () => {
    const first = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW });
    const localArticles = first.articles.map((a) => ({ ...a, previousCount: 7 }));
    const changed = makeMaster({
      revision: "rev-0002",
      articles: [
        makeMasterArticle("A1", { description: "Nieuwe omschrijving", costPrice: 9.99, countPeriod: "QUARTERLY", categoryId: "cat-lampen" }),
        makeMasterArticle("A2", { categoryId: "cat-lampen" }),
      ],
    });
    const plan = planCentralMasterApply({
      master: changed,
      local: local({ office: first.office, articles: localArticles, assignments: first.assignments, categories: first.categories }),
      previousStatus: first.status,
      now: NOW,
    });
    expect(plan.articles).toHaveLength(1);
    expect(plan.articles[0]).toMatchObject({
      id: "damme:A1",
      description: "Nieuwe omschrijving",
      costPrice: 9.99,
      countPeriod: "QUARTERLY",
      categoryId: "cat-lampen",
      previousCount: 7,
    });
    expect(plan.summary).toMatchObject({ articlesUpdated: 1, articlesUnchanged: 1 });
  });

  it("een artikel dat uit de master verdwijnt wordt enkel inactief in het assortiment, nooit verwijderd (afwezig ≠ verwijderd)", () => {
    const first = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW });
    const plan = planCentralMasterApply({
      master: makeMaster({ revision: "rev-0002", articles: [makeMasterArticle("A1")], assignments: [] }),
      local: local({ office: first.office, articles: first.articles, assignments: first.assignments, categories: first.categories }),
      previousStatus: first.status,
      now: NOW,
    });
    const a2 = plan.articles.find((a) => a.id === "damme:A2");
    expect(a2).toMatchObject({ assortmentActive: false, description: "Centraal artikel A2" });
    expect(plan.summary.articlesDeactivated).toBe(1);
    // De "ooit centraal"-lijst krimpt nooit:
    expect(plan.status.articleIds).toEqual(expect.arrayContaining(["damme:A1", "damme:A2"]));
  });

  it("een artikel dat terugkomt in de master wordt opnieuw actief", () => {
    const a2Inactive: Article = { ...makeArticle("damme", "A2"), assortmentActive: false };
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office: makeOffice(), articles: [a2Inactive] }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.articles.find((a) => a.id === "damme:A2")?.assortmentActive).toBe(true);
  });
});

describe("planCentralMasterApply — lokale TMP-artikelen en lokale data", () => {
  it("overschrijft, deactiveert of verwijdert een TMP-artikel nooit (ook niet bij adoptie van een Excel-toestel)", () => {
    for (const previousStatus of [undefined, managedStatus()]) {
      const tmp = tmpArticle();
      const plan = planCentralMasterApply({
        master: makeMaster(),
        local: local({ office: makeOffice(), articles: [tmp] }),
        previousStatus,
        now: NOW,
      });
      expect(plan.articles.find((a) => a.id === tmp.id)).toBeUndefined();
      expect(plan.summary.localArticlesKept).toBe(1);
    }
  });

  it("zelfs een TMP-artikel met hetzelfde nummer als een masterartikel-prefix blijft ongemoeid", () => {
    const tmp = tmpArticle();
    const master = makeMaster({ articles: [makeMasterArticle("A1")], assignments: [] });
    const plan = planCentralMasterApply({
      master,
      local: local({ office: makeOffice(), articles: [tmp] }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.articles.map((a) => a.id)).not.toContain(tmp.id);
  });

  it("adoptie van een Excel-toestel: niet-centrale, niet-TMP artikelen worden inactief; historische (LEGACY) artikelen blijven", () => {
    const stale: Article = { ...makeArticle("damme", "OUD"), assortmentActive: true };
    const legacy: Article = { ...makeArticle("damme", "LEG"), idType: "LEGACY" };
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office: makeOffice(), articles: [stale, legacy] }),
      previousStatus: undefined,
      now: NOW,
    });
    expect(plan.articles.find((a) => a.id === "damme:OUD")?.assortmentActive).toBe(false);
    expect(plan.articles.find((a) => a.id === "damme:LEG")).toBeUndefined();
  });

  it("na adoptie: een lokaal aangemaakt (nooit centraal) artikel wordt NIET gedeactiveerd", () => {
    const localOnly: Article = { ...makeArticle("damme", "LOKAAL"), assortmentActive: true };
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office: makeOffice(), articles: [localOnly] }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.articles.find((a) => a.id === localOnly.id)).toBeUndefined();
  });

  it("een bestaand artikel behoudt zijn lokale velden die de master niet beheert (previousCount, sourceRow)", () => {
    const existing: Article = { ...makeArticle("damme", "A1"), previousCount: 12, sourceRow: 44 };
    const plan = planCentralMasterApply({
      master: makeMaster({ articles: [makeMasterArticle("A1", { description: "Anders" })], assignments: [] }),
      local: local({ office: makeOffice(), articles: [existing] }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.articles[0]).toMatchObject({ previousCount: 12, sourceRow: 44, description: "Anders" });
  });
});

describe("planCentralMasterApply — locaties", () => {
  it("lokale locaties blijven bestaan en worden zo nodig na het hoogste mastermnummer genummerd", () => {
    const office = makeOffice();
    office.locations.push({ id: "damme:lokaal", officeId: "damme", number: 2, name: "Eigen hoek", active: true });
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office }),
      previousStatus: managedStatus({ locationIds: [] }),
      now: NOW,
    });
    const own = plan.office.locations.find((l) => l.id === "damme:lokaal");
    expect(own).toMatchObject({ active: true, name: "Eigen hoek" });
    expect(own!.number).toBeGreaterThan(2);
    const numbers = plan.office.locations.map((l) => l.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("een eerder centrale locatie die verdwijnt wordt inactief, nooit verwijderd", () => {
    const office = makeOffice();
    office.locations.push({ id: "damme:loc-3", officeId: "damme", number: 3, name: "Weg", active: true });
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office }),
      previousStatus: managedStatus({ locationIds: ["damme:loc-1", "damme:loc-2", "damme:loc-3"] }),
      now: NOW,
    });
    expect(plan.office.locations.find((l) => l.id === "damme:loc-3")).toMatchObject({ active: false });
    expect(plan.summary.locationsDeactivated).toBe(1);
  });

  it("naam/nummer van een centrale locatie wordt door de master bepaald", () => {
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office: makeOffice() }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.office.locations.find((l) => l.id === "damme:loc-1")?.name).toBe("Magazijn");
    expect(plan.summary.locationsUpdated).toBe(2);
  });
});

describe("planCentralMasterApply — koppelingen", () => {
  const assignment = (overrides: Partial<ArticleLocationAssignment> = {}): ArticleLocationAssignment => ({
    id: "damme:damme:A1:damme:loc-1",
    officeId: "damme",
    articleId: "damme:A1",
    locationId: "damme:loc-1",
    active: true,
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });

  it("een lokale koppeling die nieuwer is dan de publicatie blijft staan", () => {
    const newer = assignment({ active: false, lastSeenAt: "2026-10-05T00:00:00.000Z" });
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office: makeOffice(), articles: [makeArticle("damme", "A1")], assignments: [newer] }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.assignments.find((a) => a.id === newer.id)).toBeUndefined();
  });

  it("een oudere lokale koppeling wordt door de master overschreven", () => {
    const older = assignment({ active: false, lastSeenAt: "2026-08-01T00:00:00.000Z" });
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: local({ office: makeOffice(), articles: [makeArticle("damme", "A1")], assignments: [older] }),
      previousStatus: managedStatus(),
      now: NOW,
    });
    expect(plan.assignments.find((a) => a.id === older.id)).toMatchObject({ active: true, lastSeenAt: "2026-10-01T12:00:00.000Z" });
  });

  it("een eerder centrale koppeling die verdwijnt (artikel blijft centraal) wordt inactief; een lokaal geleerde koppeling blijft", () => {
    const central = assignment();
    const learned = assignment({ id: "damme:damme:A1:damme:loc-2", locationId: "damme:loc-2", lastSeenAt: "2026-09-15T00:00:00.000Z" });
    const plan = planCentralMasterApply({
      master: makeMaster({ assignments: [] }),
      local: local({ office: makeOffice(), articles: [makeArticle("damme", "A1")], assignments: [central, learned] }),
      previousStatus: managedStatus({ assignmentIds: [central.id] }),
      now: NOW,
    });
    expect(plan.assignments.find((a) => a.id === central.id)).toMatchObject({ active: false });
    expect(plan.assignments.find((a) => a.id === learned.id)).toBeUndefined();
  });
});

describe("planCentralMasterApply — productgamma-migratie (guard + herleiding)", () => {
  it("zet categoriesMigrated altijd op true: de eenmalige bootstrap mag nooit meer draaien", () => {
    const office = { ...makeOffice(), categoriesMigrated: false };
    const plan = planCentralMasterApply({ master: makeMaster(), local: local({ office }), previousStatus: undefined, now: NOW });
    expect(plan.office.categoriesMigrated).toBe(true);
  });

  it("een lokaal (willekeurig) productgamma met dezelfde naam maar ander id wordt herleid naar het centrale id", () => {
    const localKabels = { id: "willekeurig-uuid", name: "kabels", sortOrder: 5, active: true };
    const own: Article = { ...makeArticle("damme", "A1"), categoryId: localKabels.id };
    const other: Article = { ...makeArticle("lokeren", "Z1"), categoryId: localKabels.id };
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: { office: makeOffice(), articles: [own], allArticles: [own, other], assignments: [], categories: [localKabels] },
      previousStatus: undefined,
      now: NOW,
    });
    expect(plan.categoryIdsToDelete).toEqual(["willekeurig-uuid"]);
    expect(plan.otherOfficeArticles).toEqual([expect.objectContaining({ id: "lokeren:Z1", categoryId: "cat-kabels" })]);
    expect(plan.articles.find((a) => a.id === "damme:A1")?.categoryId).toBe("cat-kabels");
    expect(plan.summary.categoriesRemapped).toBe(1);
  });

  it("een lokaal productgamma zonder centrale tegenhanger blijft ongemoeid", () => {
    const extra = { id: "eigen", name: "Eigen gamma", sortOrder: 9, active: true };
    const plan = planCentralMasterApply({
      master: makeMaster(),
      local: { office: makeOffice(), articles: [], allArticles: [], assignments: [], categories: [extra] },
      previousStatus: undefined,
      now: NOW,
    });
    expect(plan.categoryIdsToDelete).toEqual([]);
    expect(plan.categories.map((c) => c.id)).not.toContain("eigen");
  });
});

describe("planCentralMasterApply — wat het plan NOOIT kan raken", () => {
  it("het plan bevat uitsluitend stamdata-velden (structureel geen sessies, tellingen of historiek)", () => {
    const plan = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW });
    expect(Object.keys(plan).sort()).toEqual(
      [
        "articles",
        "assignments",
        "categories",
        "categoryIdsToDelete",
        "importMeta",
        "office",
        "otherOfficeArticles",
        "selectOffice",
        "status",
        "summary",
      ].sort(),
    );
  });
});

describe("planCentralMasterApply — lokaal beheerde stockClassification", () => {
  it("een bestaand artikel wordt nooit gedowngrade door de master; een handmatige keuze blijft altijd leidend", () => {
    const first = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW });
    const localArticles = first.articles.map((a) => (a.articleNumber === "A1" ? { ...a, stockClassification: "OBSOLETE" as const } : a));
    const master = makeMaster({
      revision: "rev-0002",
      articles: [
        makeMasterArticle("A1", { stockClassification: "ACTIVE", description: "Gewijzigd" }),
        makeMasterArticle("A2", { categoryId: CATEGORY_LAMPEN.id, stockClassification: "OBSOLETE" }),
      ],
    });
    const plan = planCentralMasterApply({
      master,
      local: local({ office: first.office, articles: localArticles, assignments: first.assignments, categories: first.categories }),
      previousStatus: first.status,
      now: NOW,
    });
    const a1 = plan.articles.find((a) => a.articleNumber === "A1");
    expect(a1?.description).toBe("Gewijzigd"); // masterveld wel overgenomen
    expect(a1?.stockClassification).toBe("OBSOLETE"); // lokaal behouden
    // A2: lokaal nooit handmatig aangepast + master zegt expliciet OBSOLETE -> eenmalige bronbackfill (omhoog).
    expect(plan.articles.find((a) => a.articleNumber === "A2")?.stockClassification).toBe("OBSOLETE");
    expect(plan.articles.find((a) => a.articleNumber === "A2")?.stockClassificationManual).toBeUndefined();
  });

  it("een handmatig als ACTIVE gezet artikel wordt nooit door een master-OBSOLETE overschreven", () => {
    const first = planCentralMasterApply({ master: makeMaster(), local: emptyLocal(), previousStatus: undefined, now: NOW });
    const manual = first.articles.map((a) => ({ ...a, stockClassification: "ACTIVE" as const, stockClassificationManual: true }));
    const plan = planCentralMasterApply({
      master: makeMaster({
        revision: "rev-0003",
        articles: [makeMasterArticle("A1", { stockClassification: "OBSOLETE" }), makeMasterArticle("A2", { categoryId: CATEGORY_LAMPEN.id, stockClassification: "OBSOLETE" })],
      }),
      local: local({ office: first.office, articles: manual, assignments: first.assignments, categories: first.categories }),
      previousStatus: first.status,
      now: NOW,
    });
    expect(plan.articles.filter((a) => a.stockClassification !== "ACTIVE")).toEqual([]);
  });

  it("een nieuw artikel uit de master gebruikt de masterwaarde enkel als initiële waarde", () => {
    const plan = planCentralMasterApply({
      master: makeMaster({ articles: [makeMasterArticle("A1", { stockClassification: "OBSOLETE" })], assignments: [] }),
      local: emptyLocal(),
      previousStatus: undefined,
      now: NOW,
    });
    expect(plan.articles.find((a) => a.articleNumber === "A1")?.stockClassification).toBe("OBSOLETE");
  });
});

describe("planCentralMasterApply — tijdelijke (TMP) artikels uit de master zijn lokaal bewerkbaar", () => {
  const tmpMaster = (description: string, rev: string) =>
    makeMaster({
      revision: rev,
      articles: [
        makeMasterArticle("TMP-DAM-0003", { idType: "TIJDELIJK", description, costPrice: 385 }),
        makeMasterArticle("A1", { description }),
      ],
      assignments: [],
    });

  it("een lokale wijziging aan een TMP-artikel uit de master wordt door een volgende sync niet overschreven; gewone artikels volgen de master wel", () => {
    const first = planCentralMasterApply({ master: tmpMaster("Master v1", "rev-1"), local: emptyLocal(), previousStatus: undefined, now: NOW });
    const edited = first.articles.map((a) =>
      a.articleNumber === "TMP-DAM-0003" ? { ...a, description: "Lokaal aangepast", costPrice: 400 } : a,
    );
    const plan = planCentralMasterApply({
      master: tmpMaster("Master v2", "rev-2"),
      local: local({ office: first.office, articles: edited, assignments: first.assignments, categories: first.categories }),
      previousStatus: first.status,
      now: NOW,
    });
    expect(plan.articles.find((a) => a.articleNumber === "TMP-DAM-0003")).toBeUndefined(); // niet herschreven
    expect(plan.articles.find((a) => a.articleNumber === "A1")?.description).toBe("Master v2");
  });
});
