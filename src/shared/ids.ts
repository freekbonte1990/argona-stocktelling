/** Kleine, domeinloze utilities voor ID-vorming. Door adapters gebruikt. */

export function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // diakritische tekens weg
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "kantoor"
  );
}

export function generateSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback voor omgevingen zonder crypto.randomUUID (bv. oudere test-runners).
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
