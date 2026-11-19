import { execFileSync, spawnSync } from "node:child_process";

const SITE_ID = "6c63e64a-e307-4422-88a9-4a6f54667cb2";
const APP_URL = "https://prospection-95.netlify.app";
const EXPECTED = ["api", "dispatch-outbox", "reading-session", "sync-bobwork", "sync-drafts", "sync-mailboxes", "sync-unified-mailbox", "track-click", "track-open"].sort();
const sha = process.env.GITHUB_SHA;
if (!sha || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Publication requires the main workflow commit.");
const head = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], { encoding: "utf8" }).trim().split(/\s+/)[0];
if (head !== sha) {
  console.log("Publication skipped: main has advanced beyond this checked commit.");
  process.exit(0);
}
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!token) throw new Error("NETLIFY_AUTH_TOKEN is missing from GitHub Actions secrets. The validated build is saved; publication has not started.");
const redact = text => String(text ?? "").split(token).join("[REDACTED]");
async function api(path) {
  const response = await fetch("https://api.netlify.com/api/v1" + path, {
    headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Netlify API returned HTTP " + response.status + " for " + path);
  return response.json();
}
const site = await api("/sites/" + SITE_ID);
if (site.name !== "prospection-95") throw new Error("Unexpected deployment target.");
const result = spawnSync("npx", ["--yes", "netlify-cli", "deploy", "--prod", "--no-build", "--site", SITE_ID, "--message", "Verified GitHub Actions " + sha, "--json"], {
  encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: 240_000,
});
if (result.stderr) process.stderr.write(redact(result.stderr));
if (result.status !== 0) throw new Error("Prebuilt Netlify publication failed. " + redact(result.error?.message || ""));
let output;
try { output = JSON.parse(result.stdout); }
catch { throw new Error("Netlify CLI did not return a deployment JSON result."); }
const deployId = output.deploy_id;
if (typeof deployId !== "string") throw new Error("Netlify CLI omitted the deployment id.");
let live;
for (let attempt = 0; attempt < 60; attempt++) {
  live = await api("/sites/" + SITE_ID);
  if (live.published_deploy?.id === deployId) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
if (live.published_deploy?.id !== deployId) throw new Error("The new deployment is not the published version.");
const deployed = await api("/deploys/" + deployId);
if (deployed.state !== "ready" || !deployed.edge_functions_present) throw new Error("Deployment readiness or Edge Function verification failed.");
const functions = await api("/sites/" + SITE_ID + "/functions");
const entries = Array.isArray(functions) ? functions : functions.functions;
const names = entries.map(entry => entry.name ?? entry.n).sort();
if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) throw new Error("Published functions differ from the nine validated functions.");
if (!Array.isArray(deployed.function_schedules) || deployed.function_schedules.length !== 5) throw new Error("The five worker schedules were not preserved.");
const healthResponse = await fetch(APP_URL + "/api/health", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
const health = await healthResponse.json();
if (!healthResponse.ok || health.database !== null || health.databaseChecked !== false) throw new Error("The public health check is not the checked, database-free version.");
console.log("netlify_publish_verified " + JSON.stringify({
  deployId, commit: sha, site: APP_URL, functions: names.length, schedules: deployed.function_schedules.length, edge: true, databaseFreeHealth: true,
}));
