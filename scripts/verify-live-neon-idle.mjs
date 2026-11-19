import { getDeployStore } from "@netlify/blobs";
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!token) throw new Error("Deployment token unavailable.");
const siteID = "6c63e64a-e307-4422-88a9-4a6f54667cb2";
async function api(path) {
  const response = await fetch("https://api.netlify.com/api/v1" + path, {
    headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Control plane HTTP " + response.status);
  return response.json();
}
const site = await api("/sites/" + siteID);
const deployID = site.published_deploy.id;
const store = getDeployStore({ name: "prospection95-worker-idle", siteID, deployID, token, region: "eu-central-1", consistency: "strong" });
const output = [];
for (const worker of ["dispatch", "mailboxes", "unified", "drafts"]) {
  const hint = await store.get(worker, { type: "json", consistency: "strong" });
  const known = hint && ["quiet", "active", "quota"].includes(hint.kind);
  output.push({ worker, present: !!known, kind: known ? hint.kind : null,
    recordedAt: known && Number.isFinite(hint.at) ? new Date(hint.at).toISOString() : null,
    until: known && Number.isFinite(hint.until) ? new Date(hint.until).toISOString() : null });
}
console.log("live_worker_idle_hints " + JSON.stringify({ deployID, output }));
if (output.some(value => !value.present)) throw new Error("A live worker has not persisted its idle hint.");
