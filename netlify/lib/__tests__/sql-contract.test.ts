import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = join(process.cwd(), "db", "migrations");

describe("database safety contract", () => {
  it("keeps a contiguous additive migration set", () => {
    const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toHaveLength(20);
    expect(files.map((name) => name.slice(0, 3))).toEqual([
      "001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015", "016", "017", "018", "019", "020",
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

  it("keeps SMTP behind the explicit production switch and exposes the diagnostic route", () => {
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    const gmail = readFileSync(join(process.cwd(), "netlify", "lib", "gmail.mts"), "utf8");
    expect(api).toContain('parts[2] === "test-send"');
    expect(api).toContain("sendGmailDiagnostic");
    expect(gmail).toContain("if (!isProductionOutboundEnabled())");
    expect(gmail).toContain('"X-Prospection95-Diagnostic": "manual-test"');
  });

  it("advances past accepted sequence steps and lets the worker dispatch diagnostics", () => {
    const sql = readFileSync(join(migrationsDirectory, "014_sequence_progression_and_diagnostics.sql"), "utf8");
    const worker = readFileSync(join(process.cwd(), "netlify", "functions", "dispatch-outbox.mts"), "utf8");
    expect(sql).toContain("candidate.status IN ('prepared','pending_approval','approved','scheduled')");
    expect(worker).toContain("left join app.campaigns c on c.id = leased.campaign_id");
    expect(worker).toContain("coalesce(c.tracking_opens_enabled, false)");
  });

  it("falls back to the conversation sender when no primary Gmail exists", () => {
    const worker = readFileSync(join(process.cwd(), "netlify", "functions", "sync-drafts.mts"), "utf8");
    expect(worker).toContain("primary_candidate.role = 'primary' or primary_candidate.id = alias_account.id");
    expect(worker).toContain("case when primary_candidate.role = 'primary' then 0 else 1 end");
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

  it("grants the application role access to resources created after the base permission migration", () => {
    const sql = readFileSync(join(migrationsDirectory, "013_application_role_new_resources.sql"), "utf8");
    const verify = readFileSync(join(process.cwd(), "db", "verify.sql"), "utf8");
    expect(sql).toContain("app.instruction_attachments, app.bobwork_api_snapshots");
    expect(sql).toContain("TO prospection95_app");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA app");
    expect(verify).toContain("application_role_can_use_product_flexibility_objects");
  });

  it("persists one scheduled campaign-writing iteration at a time", () => {
    const sql = readFileSync(join(migrationsDirectory, "018_campaign_iteration_workflow.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app.campaign_iteration_runs");
    expect(sql).toContain("campaign_iteration_one_pass_per_agent_run_uq");
    expect(sql).toContain("completed_campaign_iteration_is_immutable");
    expect(sql).toContain("agent_api.claim_campaign_iteration");
    expect(sql).toContain("agent_api.complete_campaign_iteration");
    expect(sql).toContain("agent_api.fail_campaign_iteration");
    expect(sql).toContain("iteration_state.status = 'completed'");
    expect(sql).toContain("FROM PUBLIC, prospection95_agent");
  });

  it("archives one writing pass per prospect and assigned A/B variant", () => {
    const sql = readFileSync(join(migrationsDirectory, "019_prospect_variant_iteration_workflow.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app.prospect_iteration_states");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app.prospect_iteration_runs");
    expect(sql).toContain("experiment_assignments_stable_context_uq");
    expect(sql).toContain("NULLS NOT DISTINCT");
    expect(sql).toContain("agent_api.assign_prospect_variant");
    expect(sql).toContain("agent_api.claim_prospect_iteration");
    expect(sql).toContain("agent_api.complete_prospect_iteration");
    expect(sql).toContain("agent_api.propose_completed_sequence");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION agent_api.propose_sequence");
    expect(sql).toContain("GRANT prospection95_agent TO prospection95_runtime");
  });

  it("uses an unambiguous conflict target when registering prospects", () => {
    const sql = readFileSync(join(migrationsDirectory, "020_register_prospect_conflict_target.sql"), "utf8");
    expect(sql).toContain("ON CONFLICT ON CONSTRAINT campaign_prospects_pkey DO NOTHING");
    expect(sql).not.toContain("ON CONFLICT (campaign_id, prospect_id) DO NOTHING");
    expect(sql).toContain("TO prospection95_agent");
  });
});
