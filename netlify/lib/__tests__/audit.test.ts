import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlQuery = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../db.mts", () => ({ sqlQuery }));

import { auditEvent } from "../audit.mts";

describe("auditEvent", () => {
  beforeEach(() => {
    sqlQuery.mockClear();
  });

  it("passes missing states as SQL NULL instead of JSON null", async () => {
    await auditEvent({
      actor: "admin@example.com",
      action: "credential_vault_initialized",
      entityType: "credential_vault",
      entityId: "global",
      metadata: { source: "netlify_blobs" },
    });

    expect(sqlQuery).toHaveBeenCalledWith(expect.any(String), [
      "admin@example.com",
      null,
      "credential_vault_initialized",
      "credential_vault",
      "global",
      null,
      null,
      JSON.stringify({ source: "netlify_blobs" }),
    ]);
  });

  it("serializes object states for the JSONB audit columns", async () => {
    await auditEvent({
      actor: "admin@example.com",
      requestId: "ef384833-d47a-405d-b604-8152736c711f",
      action: "settings_updated",
      entityType: "settings",
      before: { enabled: false },
      after: { enabled: true },
    });

    expect(sqlQuery).toHaveBeenCalledWith(expect.any(String), [
      "admin@example.com",
      "ef384833-d47a-405d-b604-8152736c711f",
      "settings_updated",
      "settings",
      null,
      JSON.stringify({ enabled: false }),
      JSON.stringify({ enabled: true }),
      JSON.stringify({}),
    ]);
  });
});
