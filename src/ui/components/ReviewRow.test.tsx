// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewRow } from "./ReviewRow";
import type { ArticleReviewResult } from "../../domain/review";
import type { Article, Location } from "../../domain/types";

/**
 * v0.2.1-hotfix: Review moet elk ontbrekend telling direct kunnen oplossen,
 * niet enkel rapporteren. Deze tests dekken de blokkerende regressie die
 * hersteld werd — zie de aannames/commentaar in ReviewRow.tsx zelf.
 */

const locations: Location[] = [1, 2, 3].map((n) => ({
  id: `office-1:loc-${n}`,
  officeId: "office-1",
  number: n,
  name: `Rek ${n}`,
  active: true,
}));

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: "office-1:M1",
    officeId: "office-1",
    articleNumber: "M1",
    officialArticleNumber: null,
    idType: null,
    description: "Sigen BAT 8",
    productGroup: "Batterijen",
    supplier: null,
    unit: "stuk",
    costPrice: 2,
    rawCountPeriod: "MAAND",
    countPeriod: "MONTHLY",
    rawStatus: "ACTIEF",
    status: "ACTIVE",
    previousCount: 5,
    sourceRow: 1,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ArticleReviewResult> = {}): ArticleReviewResult {
  const article = makeArticle();
  return {
    articleId: article.id,
    article,
    previousCount: 5,
    perLocation: locations.map((l) => ({
      locationId: l.id,
      locationNumber: l.number,
      quantity: null,
      counted: false,
      hasEntry: false,
    })),
    fullyCounted: false,
    newTotalCount: null,
    differenceQuantity: null,
    costPrice: 2,
    previousValue: 10,
    amount: null,
    differenceAmount: null,
    note: null,
    isManualAddition: false,
    hasAnyEntry: false,
    confirmedAbsent: false,
    flaggedForControl: false,
    ...overrides,
  };
}

describe("ReviewRow — 'Tellen' voor een volledig ongeteld artikel (geen CountEntry)", () => {
  it("toont een 'Tellen'-knop, opent een locatiekeuze, en roept onRecount aan met de gekozen locatie", async () => {
    const user = userEvent.setup();
    const onRecount = vi.fn();
    const result = makeResult(); // fullyCounted: false, geen enkele entry — de exacte bug-situatie.
    render(<ReviewRow result={result} locations={locations} onRecount={onRecount} />);

    // Geen "Hertellen"-knoppen — er bestaat nog geen enkele entry.
    expect(screen.queryByText("Hertellen")).not.toBeInTheDocument();

    const tellenButton = screen.getByRole("button", { name: "Tellen" });
    await user.click(tellenButton);

    expect(screen.getByText("Kies een locatie om te tellen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rek 2" }));

    expect(onRecount).toHaveBeenCalledExactlyOnceWith(locations[1].id, result.articleId);
  });

  it("laat een locatiechip zonder entry ook rechtstreeks klikbaar zijn", async () => {
    const user = userEvent.setup();
    const onRecount = vi.fn();
    const result = makeResult();
    render(<ReviewRow result={result} locations={locations} onRecount={onRecount} />);

    // Alle drie de locaties tonen "—" (nog geen enkele entry) — elke chip is
    // afzonderlijk klikbaar; de eerste (Rek 1) telt op die locatie.
    const dashButtons = screen.getAllByRole("button", { name: "—" });
    expect(dashButtons).toHaveLength(3);
    await user.click(dashButtons[0]);

    expect(onRecount).toHaveBeenCalledExactlyOnceWith(locations[0].id, result.articleId);
  });
});

describe("ReviewRow — al geteld op één locatie", () => {
  it("toont de hoeveelheid en 'Hertellen', en roept onRecount aan met diezelfde locatie", async () => {
    const user = userEvent.setup();
    const onRecount = vi.fn();
    const result = makeResult({
      fullyCounted: true,
      hasAnyEntry: true,
      newTotalCount: 4,
      differenceQuantity: -1,
      perLocation: [
        { locationId: locations[0].id, locationNumber: 1, quantity: 4, counted: true, hasEntry: true },
        { locationId: locations[1].id, locationNumber: 2, quantity: null, counted: false, hasEntry: false },
        { locationId: locations[2].id, locationNumber: 3, quantity: null, counted: false, hasEntry: false },
      ],
    });
    render(<ReviewRow result={result} locations={locations} onRecount={onRecount} />);

    // Scope op de locatiewaarde zelf — "4" komt ook voor bij "Nieuwe telling".
    expect(screen.getByText("4", { selector: ".review-row__location-value" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hertellen" }));
    expect(onRecount).toHaveBeenCalledExactlyOnceWith(locations[0].id, result.articleId);
  });

  it("toont '+ Andere locatie' en telt op een tweede locatie via de locatiekeuze", async () => {
    const user = userEvent.setup();
    const onRecount = vi.fn();
    const result = makeResult({
      fullyCounted: true,
      hasAnyEntry: true,
      newTotalCount: 4,
      differenceQuantity: -1,
      perLocation: [
        { locationId: locations[0].id, locationNumber: 1, quantity: 4, counted: true, hasEntry: true },
        { locationId: locations[1].id, locationNumber: 2, quantity: null, counted: false, hasEntry: false },
        { locationId: locations[2].id, locationNumber: 3, quantity: null, counted: false, hasEntry: false },
      ],
    });
    render(<ReviewRow result={result} locations={locations} onRecount={onRecount} />);

    await user.click(screen.getByRole("button", { name: "+ Andere locatie" }));
    expect(screen.getByText("Kies een locatie om te tellen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rek 3" }));

    expect(onRecount).toHaveBeenCalledExactlyOnceWith(locations[2].id, result.articleId);
  });

  it("toont geen 'Tellen'-knop meer zodra het artikel volledig geteld is", () => {
    const result = makeResult({
      fullyCounted: true,
      hasAnyEntry: true,
      newTotalCount: 4,
      perLocation: [
        { locationId: locations[0].id, locationNumber: 1, quantity: 4, counted: true, hasEntry: true },
      ],
    });
    render(<ReviewRow result={result} locations={locations} onRecount={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Tellen" })).not.toBeInTheDocument();
  });
});

describe("ReviewRow — handmatige buiten-scope-toevoeging", () => {
  it("toont geen 'Tellen'/'+ Andere locatie' voor een handmatige toevoeging (die is per definitie al geteld)", () => {
    const result = makeResult({
      isManualAddition: true,
      fullyCounted: true,
      hasAnyEntry: true,
      newTotalCount: 2,
      perLocation: [
        { locationId: locations[0].id, locationNumber: 1, quantity: 2, counted: true, hasEntry: true },
      ],
    });
    render(<ReviewRow result={result} locations={locations} onRecount={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Tellen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Andere locatie" })).not.toBeInTheDocument();
  });
});
