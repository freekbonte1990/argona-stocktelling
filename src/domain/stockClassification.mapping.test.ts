import { describe, expect, it } from "vitest";
import { classificationFromLegacyFlag, initialClassificationFromStatus } from "./stockClassification";

describe("expliciete obsolete-bronstatus -> classificatie", () => {
  it("actuele artikelstatus: enkel OBSOLETE* geeft initieel OBSOLETE", () => {
    for (const raw of ["OBSOLETE", "OBSOLETE - ROOD", "OBSOLETE - PANEEL", " obsolete - rood "]) {
      expect(initialClassificationFromStatus(raw)).toBe("OBSOLETE");
    }
    for (const raw of ["ACTIEF", "NON-ACTIEF", "ZIE PANELEN", "", null, undefined]) {
      expect(initialClassificationFromStatus(raw)).toBeNull();
    }
  });

  it("legacy vlag: JA* -> OBSOLETE, NEE/NEEN -> ACTIVE, ZIE PANELEN/leeg -> onbekend", () => {
    for (const raw of ["JA", "JA - ROOD", "JA - PANEEL", "JA - HUAWEI"]) {
      expect(classificationFromLegacyFlag(raw)).toBe("OBSOLETE");
    }
    for (const raw of ["NEE", "NEEN"]) expect(classificationFromLegacyFlag(raw)).toBe("ACTIVE");
    for (const raw of ["ZIE PANELEN", "", null, undefined, "X"]) expect(classificationFromLegacyFlag(raw)).toBeUndefined();
  });
});
