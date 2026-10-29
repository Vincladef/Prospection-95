import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = join(process.cwd(), "db", "migrations");

describe("database safety contract", () => {
  it("keeps a contiguous additive migration set", () => {
    const files = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toHaveLength(29);
    expect(files.map((name) => name.slice(0, 3))).toEqual([
      "001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012", "013", "014", "015", "016", "017", "018", "019", "020", "021", "022", "023", "024", "025", "026", "027", "028", "029",
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

  it("reads writing progress per prospect and blocks premature approval", () => {
    const dashboard = readFileSync(join(process.cwd(), "netlify", "lib", "dashboard.mts"), "utf8");
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    expect(dashboard).toContain("app.prospect_iteration_states");
    expect(dashboard).not.toContain("app.campaign_iteration_states iteration_state");
    expect(dashboard).toContain("has_outbound_messages");
    expect(dashboard).toContain("state.experiment_assignment_id is not distinct from conv.experiment_assignment_id");
    expect(dashboard).toContain("not existing_message.technical_confirmation");
    expect(api).toContain("prospect_preparation_incomplete");
    expect(api).toContain("iteration_state.completed_iterations = iteration_state.total_iterations");
    expect(api).toContain("iteration_state.experiment_assignment_id is not distinct from conv.experiment_assignment_id");
  });

  it("reconciles automatic Sent messages without stopping follow-ups", () => {
    const sql = readFileSync(join(migrationsDirectory, "021_targeted_reliability_fixes.sql"), "utf8");
    const worker = readFileSync(join(process.cwd(), "netlify", "functions", "dispatch-outbox.mts"), "utf8");
    expect(worker).toContain("internet_message_id = coalesce(message.internet_message_id, $2)");
    expect(worker.indexOf("message_id_persistence_failed")).toBeLessThan(worker.indexOf("const result = await sendGmailMessage"));
    expect(sql).toContain("manual_outbound boolean := false");
    expect(sql).toContain("IF manual_outbound THEN");
    expect(sql).toContain("internet_message_id = coalesce(internet_message_id, p_internet_message_id)");
  });

  it("withdraws scheduling before SMTP without cancelling a running send", () => {
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    const sql = readFileSync(join(migrationsDirectory, "021_targeted_reliability_fixes.sql"), "utf8");
    expect(api).toContain("in_flight.status in ('reserved','running')");
    expect(api).toContain("$2 in ('draft','prepared','pending_approval','cancelled')");
    expect(api).toContain("j.status in ('requested','pending','scheduled','deferred')");
    expect(sql).toContain("message_status IS DISTINCT FROM 'scheduled'");
    expect(sql).toContain("cancel_reason = 'message_not_scheduled'");
  });

  it("computes A/B outcomes from confirmed messages and AI analyses", () => {
    const sql = readFileSync(join(migrationsDirectory, "021_targeted_reliability_fixes.sql"), "utf8");
    const dashboard = readFileSync(join(process.cwd(), "netlify", "lib", "dashboard.mts"), "utf8");
    expect(sql).toContain("m.status = 'smtp_accepted' AND m.technical_confirmation");
    expect(sql).toContain("LEFT JOIN app.inbound_analyses analysis ON analysis.message_id = m.id");
    expect(sql).toContain("analysis.meeting_confirmed");
    expect(sql).toContain("unclassified_responses");
    expect(dashboard).toContain("agent_api.experiment_metrics");
    expect(dashboard).toContain("analysis.id is null");
  });

  it("prevents concurrent cross-campaign J0 work and rechecks before SMTP", () => {
    const sql = readFileSync(join(migrationsDirectory, "021_targeted_reliability_fixes.sql"), "utf8");
    expect(sql).toContain("campaign_prospects_one_active_campaign_uq");
    expect(sql).toContain("outbox_one_active_j0_per_prospect_uq");
    expect(sql).toContain("status NOT IN ('completed','failed','cancelled')");
    expect(sql).toContain("SELECT 1 FROM app.contact_history h");
    expect(sql).toContain("cancel_reason = 'already_contacted'");
  });

  it("hashes writing inputs without coupling them to operational versions", () => {
    const sql = readFileSync(join(migrationsDirectory, "021_targeted_reliability_fixes.sql"), "utf8");
    expect(sql).toContain("writing_input_hash");
    expect(sql).toContain("generalWritingInstructions");
    expect(sql).toContain("prospect-writing-input-v2");
    expect(sql).toContain("attachment.field_key LIKE 'variant:' || p_variant_id::text");
    expect(sql).not.toContain("prospect_row.version::text");
    expect(sql).not.toContain("settings_version::text");
    expect(sql).toContain("state_row.configuration_hash, next_iteration");
  });

  it("stores campaign passes structurally and freezes work already started", () => {
    const sql = readFileSync(join(migrationsDirectory, "024_structured_campaign_editing.sql"), "utf8");
    expect(sql).toContain("writing_iteration_instructions text[]");
    expect(sql).toContain("s.completed_iterations > 0 OR EXISTS");
    expect(sql).toContain("prospect-writing-input-v3");
    expect(sql).toContain("crm_api.crm_campaign_create_v2");
    expect(sql).toContain("crm_api.crm_experiment_save");
    expect(sql).toContain("agent_api.assign_prospect_variant_v2");
    expect(sql).toContain("descriptive_variant_required");
    expect(sql).not.toContain("crm_requires_inactive");
  });

  it("supports more than ten structured writing iterations end to end", () => {
    const sql = readFileSync(join(migrationsDirectory, "025_extended_writing_iterations.sql"), "utf8");
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    const dashboard = readFileSync(join(process.cwd(), "netlify", "lib", "dashboard.mts"), "utf8");
    expect(sql).toContain("BETWEEN 1 AND 100");
    expect(sql).toContain("app.prospect_iteration_states");
    expect(sql).toContain("crm_api.crm_campaign_create_v2(jsonb,text)");
    expect(api).toContain("writingIterations: z.array(z.string().max(200_000)).min(1).max(100)");
    expect(dashboard).toContain("between 1 and 100");
    expect(dashboard).toContain("Math.min(100, numberValue(row.writing_iterations_total))");
  });

  it("treats population comparability as analysis metadata rather than a work blocker", () => {
    const sql = readFileSync(join(migrationsDirectory, "026_flexible_experiment_populations.sql"), "utf8");
    const agent = readFileSync(join(process.cwd(), "AGENT_PROSPECTION.md"), "utf8");
    expect(sql).toContain("p_requested_variant_id IS NOT NULL");
    expect(sql).toContain("selectionMode");
    expect(sql).not.toContain("requested_variant_not_allowed_for_random_test");
    expect(agent).toContain("jamais une autorisation de travailler");
    expect(agent).toContain("ne doit ni bloquer la recherche");
  });

  it("approves every remaining message in a completed sequence", () => {
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    expect(api).toContain("$2 = 'approved' and candidate.message_status in ('draft','prepared','pending_approval')");
    expect(api).toContain("from latest_messages candidate");
    expect(api).toContain("join changed_messages changed on changed.id = t.message_id");
    expect(api).toContain("insert into app.message_approvals");
  });

  it("schedules each send at a stable variable time inside the account window", () => {
    const sql = readFileSync(join(migrationsDirectory, "022_sequence_validation_and_send_distribution.sql"), "utf8");
    const api = readFileSync(join(process.cwd(), "netlify", "functions", "api.mts"), "utf8");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION app.next_account_send_at");
    expect(sql).toContain("account_row.randomize_send_times");
    expect(sql).toContain("hashtextextended");
    expect(sql).toContain("extract(isodow FROM day_value)::smallint = ANY(account_row.send_days)");
    expect(sql).toContain("app.next_account_send_at(");
    expect(sql).toContain("WHERE app.outbox_jobs.status = 'cancelled'");
    expect(api).toContain("app.next_account_send_at(t.sender_account_id");
  });

  it("keeps Gmail threads and stops only confirmed permanent bounces", () => {
    const worker = readFileSync(join(process.cwd(), "netlify", "functions", "dispatch-outbox.mts"), "utf8");
    const mailbox = readFileSync(join(process.cwd(), "netlify", "functions", "sync-mailboxes.mts"), "utf8");
    const sql = readFileSync(join(migrationsDirectory, "023_final_prospecting_cycle.sql"), "utf8");
    expect(worker).toContain("prior.internet_message_id");
    expect(worker).toContain("array_append(previous.references_header, previous.internet_message_id)");
    expect(mailbox).toContain("permanentBounce: message.isBounce ? message.isPermanentBounce : false");
    expect(sql).toContain("NEW.raw_headers->>'permanentBounce'");
    expect(sql).toContain("cancel_reason = 'permanent_bounce'");
  });

  it("exposes an autonomous A/B/C lifecycle and balances Gmail pools", () => {
    const sql = readFileSync(join(migrationsDirectory, "023_final_prospecting_cycle.sql"), "utf8");
    expect(sql).toContain("agent_api.activate_experiment");
    expect(sql).toContain("agent_api.advance_experiment");
    expect(sql).toContain("agent_api.conclude_experiment");
    expect(sql).toContain("winner_variant_id");
    expect(sql).toContain("experiments_one_open_per_campaign_uq");
    expect(sql).toContain("NOT EXISTS (\n       SELECT 1 FROM app.experiment_assignments");
    expect(sql).toContain("app.select_campaign_sender");
    expect(sql).toContain("load.assigned_count / candidate.weight");
    expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('sender:'");
  });
});
