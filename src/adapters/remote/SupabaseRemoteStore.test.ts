import { describe, expect, it, vi } from "vitest";
import { createSupabaseRemoteStoreFromEnv, SupabaseRemoteStore } from "./SupabaseRemoteStore";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("SupabaseRemoteStore", () => {
  it("upsert stuurt rijen met on_conflict en de juiste sleutels", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const store = new SupabaseRemoteStore({ url: "https://x.supabase.co/", anonKey: "KEY", fetchImpl });
    await store.upsert([{ collection: "entry", id: "e1", officeId: "damme", data: { a: 1 }, deleted: false }]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://x.supabase.co/rest/v1/sync_docs?on_conflict=collection,id");
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe("KEY");
    expect(init.headers.Prefer).toContain("merge-duplicates");
    expect(JSON.parse(init.body)).toEqual([
      { collection: "entry", id: "e1", office_id: "damme", data: { a: 1 }, deleted: false },
    ]);
  });

  it("fetchChanges filtert op kantoor en cursor, en pagineert", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      collection: "entry",
      id: `e${i}`,
      office_id: "damme",
      data: { i },
      deleted: false,
      updated_at: `2026-11-17T12:00:00.${String(i).padStart(6, "0")}+00:00`,
    }));
    const page2 = [{ ...page1[0], id: "last", updated_at: "2026-11-17T12:00:01.000000+00:00" }];
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));
    const store = new SupabaseRemoteStore({ url: "https://x.supabase.co", anonKey: "KEY", fetchImpl });

    const changes = await store.fetchChanges("damme", "2026-11-17T11:00:00.000Z");
    expect(changes).toHaveLength(1001);
    expect(changes[1000].id).toBe("last");
    const first = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(first.searchParams.get("office_id")).toBe("eq.damme");
    expect(first.searchParams.get("updated_at")).toBe("gt.2026-11-17T11:00:00.000Z");
    expect(first.searchParams.get("order")).toBe("updated_at.asc");
    const second = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(second.searchParams.get("updated_at")).toBe(`gt.${page1[999].updated_at}`);
  });

  it("gooit bij een foutstatus (zodat de sync later opnieuw probeert)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const store = new SupabaseRemoteStore({ url: "https://x.supabase.co", anonKey: "KEY", fetchImpl });
    await expect(store.upsert([{ collection: "entry", id: "e1", officeId: "d", data: {}, deleted: false }])).rejects.toThrow(
      /401/,
    );
  });

  it("createSupabaseRemoteStoreFromEnv geeft null zonder configuratie", () => {
    expect(createSupabaseRemoteStoreFromEnv({})).toBeNull();
    expect(createSupabaseRemoteStoreFromEnv({ VITE_SUPABASE_URL: "https://x" })).toBeNull();
    expect(createSupabaseRemoteStoreFromEnv({ VITE_SUPABASE_URL: "https://x", VITE_SUPABASE_ANON_KEY: "k" })).not.toBeNull();
  });
});
