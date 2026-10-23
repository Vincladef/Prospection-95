import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOBWORK_API_BASE_URL, fetchBobworkAccounts, fetchBobworkResources } from "../bobwork.mts";

describe("BobWork read-only API adapter", () => {
  const originalKey = process.env.BOBWORK_API;

  beforeEach(() => {
    process.env.BOBWORK_API = "bwk_test_only";
    const body = JSON.stringify({
      mailboxes: [{ id: "mailbox-1", email: "sender@example.com", status: "active" }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.BOBWORK_API;
    else process.env.BOBWORK_API = originalKey;
  });

  it("reads the documented mailboxes endpoint with bearer authentication", async () => {
    const result = await fetchBobworkAccounts();

    expect(result.records).toEqual([{ id: "mailbox-1", email: "sender@example.com", status: "active" }]);
    expect(fetch).toHaveBeenCalledWith(new URL(`${BOBWORK_API_BASE_URL}/mailboxes`), expect.objectContaining({
      headers: { accept: "application/json", authorization: "Bearer bwk_test_only" },
    }));
  });

  it("fails explicitly when the server variable is absent", async () => {
    delete process.env.BOBWORK_API;
    await expect(fetchBobworkAccounts()).rejects.toMatchObject({ code: "bobwork_key_missing", status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hide an upstream authentication failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    await expect(fetchBobworkAccounts()).rejects.toMatchObject({ code: "bobwork_upstream_error", status: 502 });
  });

  it("accepts the documented list nested in a data envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { mailboxes: [{ email: "nested@example.com" }] },
    }), { status: 200 })));
    await expect(fetchBobworkAccounts()).resolves.toMatchObject({ records: [{ email: "nested@example.com" }] });
  });

  it("rejects a successful response that contains no mailbox list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(fetchBobworkAccounts()).rejects.toMatchObject({ code: "bobwork_invalid_response", status: 502 });
  });

  it("reads the documented stats and domains resources without turning them into write commands", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      return new Response(JSON.stringify(url.endsWith("/stats") ? { sent: 12 } : { domains: ["example.com"] }), { status: 200 });
    }));

    const result = await fetchBobworkResources();

    expect(result.map((item) => item.resource)).toEqual(["stats", "domains"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
