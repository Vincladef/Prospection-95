import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = join(process.cwd(), "db", "migrations");

describe("database safety contract", () => {
  it("keeps a contiguous additive migration set", () => {
    const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toHaveLength(11);
    expect(files.map((name) => name.slice(0, 3))).toEqual([
      "001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011",
    ]);
  });

  it("guards every lease with the persistent stop, account limits and exclusions", () => {
    const sql = readFileSync(join(migrationsDirectory, "002_messaging.sql"), "utf8");
    expect(sql).toContain("s.outbound_enabled AND NOT s.emergency_stop");
    expect(sql).toContain("LEAST(account_row.daily_limit");
    expect(sql).toContain("NOT app.is_excluded(p.normalized_email)");
    expect(sql).toContain("lease_expired_while_running");
  });

  it("never grants the agent direct vault or SMTP confirmation access", () => {
    const sql = readFileSync(join(migrationsDirectory, "005_permissions.sql"), "utf8");
    const verify = readFileSync(join(process.cwd(), "db", "verify.sql"), "utf8");
    expect(sql).toContain("REVOKE ALL ON SCHEMA vault FROM prospection95_agent");
    expect(sql).toContain("restent backend-only");
    expect(verify).toContain("app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)");
  });

  it("casts both Gmail verification states to the account enum", () => {
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    expect(api).toContain("'active'::app.account_status");
    expect(api).toContain("'error'::app.account_status");
  });

  it("keeps campaign SMTP blocked while exposing only the explicit diagnostic route", () => {
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    const gmail = readFileSync(join(process.cwd(), "netlify", "lib", "gmail.mts"), "utf8");
    expect(api).toContain('parts[2] === "test-send"');
    expect(api).toContain("sendGmailDiagnostic");
    expect(gmail).toContain("if (!isProductionOutboundEnabled())");
    expect(gmail).toContain('"X-Prospection95-Diagnostic": "manual-test"');
  });

  it("persists A/B variant creation and overrides through private routes", () => {
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    expect(api).toContain("addExperimentVariant");
    expect(api).toContain("updateExperimentVariant");
    expect(api).toContain('parts[0] === "experiment-variants"');
    expect(api).toContain("overrides = coalesce($4::jsonb, v.overrides)");
  });

  it("keeps interaction observations private and seeds the V53 verifier catalog", () => {
    const sql = readFileSync(join(migrationsDirectory, "010_signed_interaction_tracking_and_v53_verifiers.sql"), "utf8");
    expect(sql).toContain("ALTER TABLE app.tracking_events");
    expect(sql).toContain("REVOKE ALL ON TABLE app.tracking_events FROM PUBLIC, prospection95_agent");
    expect(sql).toContain("'Mail-Tester'");
    expect(sql).toContain("'CaptainDNS'");
  });

  it("matches the V53 interaction-tracking defaults", () => {
    const sql = readFileSync(join(migrationsDirectory, "011_v53_tracking_defaults.sql"), "utf8");
    expect(sql).toContain("tracking_opens_enabled SET DEFAULT true");
    expect(sql).toContain("tracking_clicks_enabled SET DEFAULT true");
    expect(sql).toContain("SET tracking_opens_enabled = true");
  });
});
