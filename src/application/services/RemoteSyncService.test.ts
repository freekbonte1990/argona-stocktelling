import { beforeEach, describe, expect, it } from "vitest";
import { CountSessionService } from "./CountSessionService";
import { CountingService } from "./CountingService";
import { InMemoryCountingRepository } from "./InMemoryCountingRepository";
import { RemoteSyncService } from "./RemoteSyncService";
import type { RemoteChange, RemoteDoc, RemoteStore } from "../ports/RemoteStore";
import type { Article, Office } from "../../domain/types";

/** Gesimuleerde server: bewaart documenten, zet `updatedAt` zelf (monotoon) en kan offline gaan. */
class FakeRemote implements RemoteStore {
  docs = new Map<string, RemoteChange>();
  online = true;
  private clock = 0;
  upsertCalls = 0;

  async upsert(docs: RemoteDoc[]): Promise<void> {
    if (!this.online) throw new Error("offline");
    this.upsertCalls += 1;
    for (const d of docs) {
      this.clock += 1;
      this.docs.set(`${d.collection}|${d.id}`, {
        ...d,
        // jsonb bewaart sleutelvolgorde niet: simuleer dat door een kopie met omgekeerde sleutels.
        data: d.data === null ? null : reverseKeys(d.data),
        updatedAt: new Date(Date.UTC(2026, 10, 17, 12, 0, 0, this.clock)).toISOString(),
      });
    }
  }

  async fetchChanges(officeId: string, since: string | null): Promise<RemoteChange[]> {
    if (!this.online) throw new Error("offline");
    return [...this.docs.values()]
      .filter((d) => d.officeId === officeId && (since === null || d.updatedAt > since))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
}

function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeys(v)]));
}

function makeArticle(articleNumber: string, overrides: Partial<Article> = {}): Article {
  return {
    id: `office-1:${articleNumber}`,
    officeId: "office-1",
    articleNumber,
    officialArticleNumber: null,
    idType: null,
    description: "Test",
    productGroup: "GROEP",
    supplier: null,
    unit: "stuk",
    costPrice: 2,
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
  name: "Damme",
  baseDate: "2026-09-01",
  locations: [1, 2].map((n) => ({
    id: `office-1:loc-${n}`,
    officeId: "office-1",
    number: n,
    name: `Locatie ${n}`,
    active: true,
  })),
};

async function makeDevice(remote: RemoteStore | null, syncFrom = "2000-01-01T00:00:00.000Z") {
  const repository = new InMemoryCountingRepository();
  await repository.saveOffice(office);
  await repository.saveArticles([makeArticle("M1"), makeArticle("M2")]);
  return {
    repository,
    sessions: new CountSessionService(repository),
    counting: new CountingService(repository),
    sync: new RemoteSyncService(repository, remote, { syncFrom }),
  };
}

describe("RemoteSyncService", () => {
  let remote: FakeRemote;
  beforeEach(() => {
    remote = new FakeRemote();
  });

  it("zonder server (niet geconfigureerd) is de synchronisatie uit en gebeurt er niets", async () => {
    const device = await makeDevice(null);
    expect(device.sync.getStatus().state).toBe("disabled");
    const status = await device.sync.syncNow();
    expect(status.state).toBe("disabled");
  });

  it("een lopende telling met invoeren komt op de server en een tweede toestel krijgt ze te zien", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    await a.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 7 });
    expect((await a.sync.syncNow()).state).toBe("idle");

    const b = await makeDevice(remote);
    await b.sync.syncNow();

    const active = await b.repository.getActiveSession("office-1");
    expect(active?.id).toBe(session.id);
    const entries = await b.repository.getCountEntries(session.id);
    expect(entries.find((e) => e.articleId === "office-1:M1")?.quantity).toBe(7);
  });

  it("na een geslaagde synchronisatie wordt er niets meer verstuurd (geen echo of dubbele uploads)", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    await a.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 1 });
    await a.sync.syncNow();
    const calls = remote.upsertCalls;
    await a.sync.syncNow();
    expect(remote.upsertCalls).toBe(calls);

    const b = await makeDevice(remote);
    await b.sync.syncNow();
    const afterB = remote.upsertCalls;
    await b.sync.syncNow();
    expect(remote.upsertCalls).toBe(afterB); // toestel B gaf niets terug dat het net ontving
  });

  it("offline: niets gaat verloren; zodra de server weer bereikbaar is, wordt alles alsnog verstuurd", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    remote.online = false;
    await a.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 4 });
    const failed = await a.sync.syncNow();
    expect(failed.state).toBe("error");
    expect(failed.pending).toBeGreaterThan(0);
    expect(remote.docs.size).toBe(0);

    remote.online = true;
    const ok = await a.sync.syncNow();
    expect(ok.state).toBe("idle");
    expect(ok.pending).toBe(0);
    expect([...remote.docs.keys()].some((k) => k === `session|${session.id}`)).toBe(true);
  });

  it("een nog niet geüploade lokale wijziging wint van wat de server heeft", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    await a.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 1 });
    await a.sync.syncNow();
    const b = await makeDevice(remote);
    await b.sync.syncNow();

    // B telt 9 (nog niet gesynchroniseerd); intussen zet A 5 op de server.
    await b.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 9 });
    await a.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 5 });
    await a.sync.syncNow();
    await b.sync.syncNow();

    const entry = (await b.repository.getCountEntries(session.id)).find((e) => e.articleId === "office-1:M1");
    expect(entry?.quantity).toBe(9);
    await a.sync.syncNow();
    const onA = (await a.repository.getCountEntries(session.id)).find((e) => e.articleId === "office-1:M1");
    expect(onA?.quantity).toBe(9);
  });

  it("een lokaal verwijderd record wordt als tombstone doorgegeven en verdwijnt ook op het andere toestel", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    await a.counting.recordCount({ session, articleId: "office-1:M1", locationId: office.locations[0].id, quantity: 2 });
    await a.sync.syncNow();
    const b = await makeDevice(remote);
    await b.sync.syncNow();
    expect(await b.repository.getSession(session.id)).toBeDefined();

    // Annuleren verwijdert niets; verwijderen van een locatiestatus wel via applySyncedDocs-pad: simuleer lokaal verwijderen.
    await a.repository.applySyncedDocs("office-1", [
      { collection: "session", id: session.id, deleted: true, data: null },
    ]);
    await a.sync.syncNow();
    expect(remote.docs.get(`session|${session.id}`)?.deleted).toBe(true);
    await b.sync.syncNow();
    expect(await b.repository.getSession(session.id)).toBeUndefined();
  });

  it("geannuleerde en heractiveerde statussen worden gesynchroniseerd", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    await a.sessions.cancelSession(session.id);
    await a.sync.syncNow();
    const b = await makeDevice(remote);
    await b.sync.syncNow();
    expect((await b.repository.getSession(session.id))?.status).toBe("CANCELLED");

    await b.sessions.reopenSession(session.id);
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect((await a.repository.getSession(session.id))?.status).toBe("ACTIVE");
  });

  it("sessies van vóór de ingangsdatum en centrale (central-…) sessies worden niet gesynchroniseerd", async () => {
    const a = await makeDevice(remote, "2999-01-01T00:00:00.000Z");
    await a.sessions.startSession("office-1", "MONTHLY");
    await a.sync.syncNow();
    expect([...remote.docs.keys()].filter((k) => k.startsWith("session|"))).toHaveLength(0);

    const c = await makeDevice(remote);
    await c.repository.createSession({
      id: "central-2026-Q3",
      officeId: "office-1",
      type: "QUARTERLY",
      status: "COMPLETED",
      startedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T00:00:00.000Z",
      sourceFileName: "Hersteld uit centrale historiek",
      sourceBaseDate: null,
      articleIds: [],
      activeLocationIds: [],
    } as never);
    await c.sync.syncNow();
    expect(remote.docs.has("session|central-2026-Q3")).toBe(false);
  });

  it("een afgeronde telling met haar resultaat en de nieuwe 'vorige telling' komt bij het andere toestel terecht", async () => {
    const a = await makeDevice(remote);
    const session = await a.sessions.startSession("office-1", "MONTHLY");
    for (const article of ["M1", "M2"]) {
      await a.counting.recordCount({
        session,
        articleId: `office-1:${article}`,
        locationId: office.locations[0].id,
        quantity: 6,
      });
    }
    for (const location of office.locations) await a.counting.completeLocation(session.id, location.id);
    await a.sessions.completeSession(session.id);
    await a.sync.syncNow();

    const b = await makeDevice(remote);
    await b.sync.syncNow();
    expect((await b.repository.getSession(session.id))?.status).toBe("COMPLETED");
    expect(await b.repository.getFinalizedSessionResult(session.id)).toBeDefined();
    const articles = await b.repository.getArticles("office-1");
    expect(articles.find((x) => x.articleNumber === "M1")?.previousCount).toBe(6);
    // en B geeft niets terug
    const calls = remote.upsertCalls;
    await b.sync.syncNow();
    expect(remote.upsertCalls).toBe(calls);
  });
});
