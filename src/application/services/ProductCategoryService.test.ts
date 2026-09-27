import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { ProductCategoryService } from "./ProductCategoryService";
import type { Article, Office } from "../../domain/types";

/**
 * Sprint 3.2.1-architectuurfix: `ProductCategory` is bedrijfsbreed/globaal
 * geworden (geen `officeId` meer) — deze test bewijst expliciet het
 * kernscenario uit de architectuurcorrectie: "Kabels" (of hier "Kabels"/
 * "Laadpalen") mag NOOIT als drie aparte records met verschillende ID's
 * ontstaan wanneer meerdere kantoren onafhankelijk migreren, en de
 * per-kantoor migratiebootstrap (`Office.categoriesMigrated`) moet voor élk
 * kantoor apart lopen, ook nadat een ANDER kantoor de globale lijst al
 * niet-leeg gemaakt heeft.
 */

function makeArticle(id: string, officeId: string, productGroup: string | null): Article {
  return {
    id,
    officeId,
    articleNumber: id.split(":")[1] ?? id,
    officialArticleNumber: null,
    idType: null,
    description: `Artikel ${id}`,
    productGroup,
    supplier: null,
    unit: "stuk",
    costPrice: 1,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 0,
    sourceRow: 1,
  };
}

function makeOffice(id: string, name: string): Office {
  return { id, name, baseDate: null, locations: [] };
}

describe("ProductCategoryService — Sprint 3.2.1: globale (bedrijfsbrede) Productgamma's", () => {
  let repository: InMemoryCountingRepository;
  let service: ProductCategoryService;

  beforeEach(async () => {
    repository = new InMemoryCountingRepository();
    service = new ProductCategoryService(repository);
    await repository.saveOffice(makeOffice("antwerpen", "Antwerpen"));
    await repository.saveOffice(makeOffice("damme", "Damme"));
    await repository.saveOffice(makeOffice("lokeren", "Lokeren"));
  });

  it("migreert dezelfde bronproductgroepnaam van drie kantoren naar ÉÉN gedeelde categorie-ID, nooit drie aparte records", async () => {
    await repository.saveArticles([
      makeArticle("antwerpen:A1", "antwerpen", "Kabels"),
      makeArticle("damme:A1", "damme", "KABELS"), // hoofdletterverschil -> zelfde genormaliseerde naam
      makeArticle("lokeren:A1", "lokeren", "Kabels"),
    ]);

    // Elk kantoor triggert zijn EIGEN migratiebootstrap (via listCategories),
    // in een bewust andere volgorde dan de aanmaak hierboven.
    const damme = await service.listCategories("damme");
    const antwerpen = await service.listCategories("antwerpen");
    const lokeren = await service.listCategories("lokeren");

    // Geen drie aparte "Kabels"-records: één enkele globale categorie, over
    // alle drie de leeslijnen heen exact dezelfde stabiele ID.
    expect(damme).toHaveLength(1);
    expect(antwerpen).toHaveLength(1);
    expect(lokeren).toHaveLength(1);
    const kabelsId = damme[0].id;
    expect(antwerpen[0].id).toBe(kabelsId);
    expect(lokeren[0].id).toBe(kabelsId);
    expect(damme[0].name).toBe("KABELS");

    // Elk kantoor se eigen artikel is toegewezen aan diezelfde globale ID.
    // (Damme migreerde hier als EERSTE — "welke naam wint" is dus "KABELS",
    // Damme's eigen brontekst; het punt van deze test is de gedeelde ID, niet
    // welke van de drie hoofdlettervarianten als canonieke naam wint.)
    const allArticles = await repository.getAllArticles();
    for (const article of allArticles) {
      expect(article.categoryId).toBe(kabelsId);
    }

    // De migratievlag staat nu voor ALLE DRIE de kantoren apart aan.
    const offices = await repository.getAllOffices();
    for (const office of offices) {
      expect(office.categoriesMigrated).toBe(true);
    }
  });

  it("is per kantoor idempotent: een tweede migratiebeurt voor kantoor A herhaalt zich niet, ook nadat kantoor B intussen gemigreerd is", async () => {
    await repository.saveArticles([
      makeArticle("antwerpen:A1", "antwerpen", "Batterijen"),
      makeArticle("damme:A1", "damme", "Batterijen"),
    ]);

    const firstAntwerpen = await service.listCategories("antwerpen");
    expect(firstAntwerpen).toHaveLength(1);

    // Damme migreert nu ook (de globale lijst was, vóór deze architectuurfix,
    // al niet-leeg door Antwerpen — de oude gate had Damme's eigen migratie
    // hier stilzwijgend overgeslagen).
    const damme = await service.listCategories("damme");
    expect(damme).toHaveLength(1);
    expect(damme[0].id).toBe(firstAntwerpen[0].id);

    // Een hernieuwde, bewuste beheeractie (hernoemen) op de gedeelde
    // categorie mag door een volgende `listCategories`-aanroep voor eender
    // welk kantoor NOOIT ongedaan gemaakt worden door een herhaalde migratie.
    await service.renameCategory("antwerpen", firstAntwerpen[0].id, "Herbenoemd");
    const afterRename = await service.listCategories("damme");
    expect(afterRename).toHaveLength(1);
    expect(afterRename[0].name).toBe("Herbenoemd");
  });

  it("kan een globale categorie enkel als 'niet-gebruikt' verwijderen wanneer ZE bij GEEN ENKEL kantoor meer toegewezen is", async () => {
    // Enkel Damme's artikel heeft deze bronproductgroep — Antwerpen migreert
    // met een LEGE artikellijst en heeft dus zelf geen toewijzing aan
    // "Zonnepanelen"; de categorie bestaat voor Antwerpen enkel omdat ze
    // globaal/bedrijfsbreed is (via Damme's migratie).
    await repository.saveArticles([makeArticle("damme:A1", "damme", "Zonnepanelen")]);
    const [zonnepanelen] = await service.listCategories("damme");
    await service.listCategories("antwerpen"); // ook Antwerpen's eigen bootstrap laten lopen (geen productGroups -> geen nieuwe categorieën)

    // Nog steeds bij Damme in gebruik -> verwijderen vanuit Antwerpen's scherm moet weigeren,
    // ook al heeft Antwerpen zelf geen enkel artikel met deze categorie.
    await expect(service.deleteUnusedCategory("antwerpen", zonnepanelen.id)).rejects.toThrow(/toegewezen/);

    // Verplaats Damme's toewijzing weg, dan pas is de categorie overal ongebruikt.
    await service.assignArticles("damme", ["damme:A1"], null);
    const remaining = await service.deleteUnusedCategory("antwerpen", zonnepanelen.id);
    expect(remaining.find((c) => c.id === zonnepanelen.id)).toBeUndefined();
  });

  it("mergeCategories verplaatst toewijzingen over ALLE kantoren heen, niet enkel het kantoor van waaruit de samenvoeging gestart werd", async () => {
    await repository.saveArticles([
      makeArticle("antwerpen:A1", "antwerpen", "Connectivity"),
      makeArticle("damme:A1", "damme", "Connectivity"),
      makeArticle("lokeren:A1", "lokeren", "Smart meters"),
    ]);
    const [connectivity] = await service.listCategories("antwerpen");
    await service.listCategories("damme");
    const smartMeters = (await service.listCategories("lokeren")).find((c) => c.name === "Smart meters")!;

    const result = await service.mergeCategories("lokeren", connectivity.id, smartMeters.id);
    // Zowel Antwerpen's als Damme's artikel verhuisden mee, ook al werd de
    // samenvoeging vanuit Lokeren's scherm gestart.
    expect(result.movedArticleCount).toBe(2);

    const allArticles = await repository.getAllArticles();
    const antwerpenArticle = allArticles.find((a) => a.id === "antwerpen:A1")!;
    const dammeArticle = allArticles.find((a) => a.id === "damme:A1")!;
    expect(antwerpenArticle.categoryId).toBe(smartMeters.id);
    expect(dammeArticle.categoryId).toBe(smartMeters.id);
  });
});
