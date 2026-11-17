import { describe, expect, it } from "vitest";
import { canonicalStringify, diffLocalDocs, docKey, hashDoc } from "./remoteSync";

describe("remoteSync", () => {
  it("hash is onafhankelijk van sleutelvolgorde en negeert undefined", () => {
    expect(hashDoc({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashDoc({ b: { d: [1, 2], c: 2 }, a: 1, z: undefined }));
    expect(hashDoc({ a: 1 })).not.toBe(hashDoc({ a: 2 }));
    expect(canonicalStringify({ b: 1, a: null })).toBe('{"a":null,"b":1}');
  });

  it("diff vindt nieuwe, gewijzigde en verwijderde documenten", () => {
    const states = new Map([
      [docKey("entry", "e1"), hashDoc({ q: 1 })],
      [docKey("entry", "e2"), hashDoc({ q: 2 })],
      [docKey("entry", "e3"), hashDoc({ q: 3 })],
    ]);
    const { upserts, deletions } = diffLocalDocs(
      [
        { collection: "entry", id: "e1", data: { q: 1 } },
        { collection: "entry", id: "e2", data: { q: 20 } },
        { collection: "entry", id: "e4", data: { q: 4 } },
      ],
      states,
    );
    expect(upserts.map((d) => d.id).sort()).toEqual(["e2", "e4"]);
    expect(deletions).toEqual([{ collection: "entry", id: "e3" }]);
  });
});
