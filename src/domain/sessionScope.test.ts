import { describe, expect, it } from "vitest";
import { isArticleInSessionScope, requiresOutOfScopeConfirmation } from "./sessionScope";

const session = { articleIds: ["office-1:M1", "office-1:M2"] };

describe("isArticleInSessionScope", () => {
  it("is true voor een artikel in de sessiescope", () => {
    expect(isArticleInSessionScope(session, "office-1:M1")).toBe(true);
  });
  it("is false voor een artikel buiten de sessiescope", () => {
    expect(isArticleInSessionScope(session, "office-1:Q1")).toBe(false);
  });
});

describe("requiresOutOfScopeConfirmation", () => {
  it("vereist geen bevestiging voor een artikel binnen de scope", () => {
    expect(requiresOutOfScopeConfirmation(session, "office-1:M1", false)).toBe(false);
  });

  it("vereist een bevestiging voor een artikel buiten de scope zonder bestaande entry", () => {
    expect(requiresOutOfScopeConfirmation(session, "office-1:Q1", false)).toBe(true);
  });

  it("vereist geen nieuwe bevestiging als er al een entry bestaat (bv. hoeveelheid corrigeren)", () => {
    expect(requiresOutOfScopeConfirmation(session, "office-1:Q1", true)).toBe(false);
  });
});
