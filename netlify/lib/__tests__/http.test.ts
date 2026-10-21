import { afterEach, describe, expect, it } from "vitest";
import { assertMutationOrigin, HttpError } from "../http.mts";

describe("mutation origin protection", () => {
  afterEach(() => delete process.env.APP_BASE_URL);

  it("rejects a cross-origin mutation", () => {
    process.env.APP_BASE_URL = "https://prospection-95.netlify.app";
    const request = new Request("https://prospection-95.netlify.app/api/settings", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    expect(() => assertMutationOrigin(request)).toThrow(HttpError);
  });

  it("accepts the configured production origin", () => {
    process.env.APP_BASE_URL = "https://prospection-95.netlify.app";
    const request = new Request("https://prospection-95.netlify.app/api/settings", {
      method: "POST",
      headers: { origin: "https://prospection-95.netlify.app" },
    });
    expect(() => assertMutationOrigin(request)).not.toThrow();
  });
});
