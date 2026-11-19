import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ping: vi.fn(), one: vi.fn(), query: vi.fn(), admin: vi.fn() }));
vi.mock("../db.mts", () => ({ pingDatabase: mocks.ping, sqlOne: mocks.one, sqlQuery: mocks.query }));
vi.mock("../auth.mts", () => ({ requireAdmin: mocks.admin }));
import handler from "../../functions/api.mts";
import { HttpError } from "../http.mts";

describe("health checks without idle database wakeups", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DATABASE_URL", "postgres://unused.invalid/test");
    mocks.admin.mockResolvedValue({ email: "admin@example.invalid", subject: "test" });
    mocks.ping.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("serves a public liveness check without connecting to Neon", async () => {
    const response = await handler(new Request("https://example.test/api/health"), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", configured: true, database: null, databaseChecked: false });
    expect(mocks.ping).not.toHaveBeenCalled();
    expect(mocks.one).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("requires administrator authentication for a deliberate database probe", async () => {
    mocks.admin.mockRejectedValue(new HttpError(401, "unauthorized", "Authentication required"));
    const response = await handler(new Request("https://example.test/api/health?database=1"), {} as never);
    expect(response.status).toBe(401);
    expect(mocks.ping).not.toHaveBeenCalled();
  });
  it("reports the actual result of an authenticated database probe", async () => {
    const response = await handler(new Request("https://example.test/api/health?database=1"), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ database: true, databaseChecked: true });
    expect(mocks.ping).toHaveBeenCalledTimes(1);
    mocks.ping.mockResolvedValue(false);
    const unavailable = await handler(new Request("https://example.test/api/health?database=1"), {} as never);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ database: false, databaseChecked: true });
  });
});
