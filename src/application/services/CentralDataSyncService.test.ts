import { beforeEach, describe, expect, it } from "vitest";
import { CentralDataSyncService } from "./CentralDataSyncService";
import { CentralHistorySyncService } from "./CentralHistorySyncService";
import { CentralMasterSyncService } from "./CentralMasterSyncService";
import { CountSessionService } from "./CountSessionService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import {
  FakeCentralHistorySource,
  makeEntry,
  makeFile,
  offline,
} from "./centralHistoryTestUtils";
import { FakeCentralMasterSource, makeMaster, masterOffline } from "./centralMasterTestUtils";
import { CentralMasterError } from "../ports/CentralMasterSource";

let repository: InMemoryCountingRepository;
let masterSource: FakeCentralMasterSource;
let historySource: FakeCentralHistorySource;
let service: CentralDataSyncService;
let nowMs: number;

const aug = (articleNumber: string, totalCount: number, overrides = {}) =>
  makeEntry({ articleId: `damme:${articleNumber}`, articleNumber, totalCount, ...overrides });

beforeEach(async () => {
  repository = new InMemoryCountingRepository();
  masterSource = new FakeCentralMasterSource(makeMaster());
  historySource = new FakeCentralHistorySource(makeFile([aug("A1", 10), aug("A2", 3)]));
  nowMs = Date.parse("2026-10-06T08:00:00.000Z");
  const now = () => new Date(nowMs);
  service = new CentralDataSyncService(
    repository,
    new CentralMasterSyncService(repository, masterSource, { now }),
    new CentralHistorySyncService(repository, historySource, { now }),
  );
});

describe("CentralDataSyncService.bootstrapOffice — nieuw toestel", () => {
  it("volgorde: master → historiek → 'Vorige telling' uit de historiek; app is meteen bruikbaar", async () => {
    const result = await service.bootstrapOffice("damme");
    expect(result).toMatchObject({ ok: true, message: null });
    expect(result.master.outcome).toBe("applied");
    expect(result.history?.outcome).toBe("synced");

    expect(await repository.getSelectedOfficeId()).toBe("damme");
    expect(await repository.getArticles("damme")).toHaveLength(2);
    expect((await repository.getSessionsForOffice("damme")).map((s) => s.status)).toEqual(["COMPLETED"]);

    const byNumber = new Map((await repository.getArticles("damme")).map((a) => [a.articleNumber, a]));
    // previousCount komt enkel uit de historiek (de master bevat het niet):
    expect(byNumber.get("A1")?.previousCount).toBe(10);
    expect(byNumber.get("A2")?.previousCount).toBe(3);
  });

  it("mislukte master → ok:false, NIETS lokaal, en de historiek wordt niet eens geprobeerd", async () => {
    masterSource.set(masterOffline());
    const result = await service.bootstrapOffice("damme");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("niet bereikbaar");
    expect(result.history).toBeNull();
    expect(historySource.calls).toBe(0);
    expect(await repository.getAllOffices()).toEqual([]);
  });

  it("een kantoor zonder gepubliceerde master → ok:false met een begrijpelijke melding (en niets lokaal)", async () => {
    masterSource.set(new CentralMasterError("not-found", "x"));
    const result = await service.bootstrapOffice("damme");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nog geen centrale masterdata");
    expect(await repository.getAllOffices()).toEqual([]);
  });

  it("mislukte historiek blokkeert niet: master staat lokaal, ok:true, een latere sync haalt de historiek alsnog op", async () => {
    historySource.set(offline());
    const result = await service.bootstrapOffice("damme");
    expect(result.ok).toBe(true);
    expect(result.history?.outcome).toBe("failed");
    expect(await repository.getArticles("damme")).toHaveLength(2);
    expect(await repository.getSessionsForOffice("damme")).toEqual([]);

    historySource.set(makeFile([aug("A1", 10)]));
    nowMs += 1000;
    const later = await service.syncOffice("damme", { force: true });
    expect(later.history.outcome).toBe("synced");
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.previousCount).toBe(10);
  });
});

describe("CentralDataSyncService.syncOffice — achtergrond", () => {
  beforeEach(async () => {
    await service.bootstrapOffice("damme");
  });

  it("gooit nooit, ook niet als beide bronnen offline zijn; lokale data blijft", async () => {
    masterSource.set(masterOffline());
    historySource.set(offline());
    nowMs += 3_600_000;
    const result = await service.syncOffice("damme", { force: true });
    expect(result.master.outcome).toBe("failed");
    expect(result.history.outcome).toBe("failed");
    expect(await repository.getArticles("damme")).toHaveLength(2);
  });

  it("een mislukte master blokkeert de historiek niet (en omgekeerd)", async () => {
    masterSource.set(masterOffline());
    historySource.set(makeFile([aug("A1", 10), aug("A1", 12, { countDate: "2026-09-30", sessionName: "2026-09 Maand", sourceSessionId: "session-sep" })]));
    nowMs += 3_600_000;
    const result = await service.syncOffice("damme", { force: true });
    expect(result.master.outcome).toBe("failed");
    expect(result.history.outcome).toBe("synced");
    // Nieuwste telling (sep: 12) wordt het nieuwe 'vorige':
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.previousCount).toBe(12);
  });

  it("'Vorige telling' wordt NIET afgeleid tijdens een actieve telling (de lopende telling blijft stabiel)", async () => {
    const sessions = new CountSessionService(repository);
    await sessions.startSession("damme", "MONTHLY");
    historySource.set(makeFile([aug("A1", 99, { countDate: "2026-10-01", sessionName: "2026-10 Maand", sourceSessionId: "session-okt" })]));
    nowMs += 3_600_000;
    await service.syncOffice("damme", { force: true });
    expect((await repository.getArticles("damme")).find((a) => a.articleNumber === "A1")?.previousCount).toBe(10);
    expect(await service.deriveAndSavePreviousCounts("damme")).toBe(0);
  });

  it("voor een kantoor zonder centrale master (Excel-toestel) wordt previousCount nooit herschreven", async () => {
    await repository.saveOffice({ id: "lokeren", name: "Lokeren", baseDate: null, locations: [] });
    expect(await service.deriveAndSavePreviousCounts("lokeren")).toBe(0);
  });
});
