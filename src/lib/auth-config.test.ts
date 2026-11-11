import { describe, expect, it } from "vitest";
import { resolveNeonAuthUrl } from "./auth-config";

describe("production authentication configuration", () => {
  it.each([undefined, "", "   "])("rejects a build missing its authentication endpoint (%s)", value => {
    expect(() => resolveNeonAuthUrl(value, true)).toThrow("VITE_NEON_AUTH_URL is required");
  });
  it.each(["http://localhost:54321/auth", "https://localhost/auth", "https://127.0.0.1/auth", "https://[::1]/auth", "not a URL"])("rejects a production endpoint that cannot serve the hosted app (%s)", value => {
    expect(() => resolveNeonAuthUrl(value, true)).toThrow("VITE_NEON_AUTH_URL");
  });
  it("preserves the configured branch and auth path", () => {
    const endpoint = "https://branch.neonauth.example/neondb/auth";
    expect(resolveNeonAuthUrl(endpoint, true)).toBe(endpoint);
  });
  it("keeps the localhost fallback available for local development", () => {
    expect(resolveNeonAuthUrl(undefined, false)).toBe("http://localhost:54321/auth");
  });
});
