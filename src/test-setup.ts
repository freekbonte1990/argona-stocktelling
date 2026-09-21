import "@testing-library/jest-dom/vitest";

// jsdom implementeert scrollIntoView niet (https://github.com/jsdom/jsdom/issues/1695).
// CountingPage roept dit aan bij focus/auto-scroll (v0.2.1-hotfix) — zonder
// deze stub gooit dat een onafgehandelde exception in component-tests die in
// jsdom draaien. Enkel relevant/aanwezig in de jsdom-omgeving; de overige
// (node-omgeving) tests raken dit nooit.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
