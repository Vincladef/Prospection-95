import { getAccessToken } from "./auth";
import type { ApiErrorPayload, Campaign, DashboardData, GmailTestSendResult, GmailVerificationResult, ImportPreview } from "../types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message || payload.error || `Erreur API ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code;
    this.details = payload.details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as T & ApiErrorPayload;
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export const api = {
  dashboard: () => request<DashboardData>("/dashboard"),
  updateSettings: (payload: Record<string, unknown>) =>
    request<{ settings: DashboardData["settings"] }>("/settings", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  setEmergencyStop: (enabled: boolean, reason: string) =>
    request<{ settings: DashboardData["settings"] }>("/emergency-stop", {
      method: "POST",
      body: JSON.stringify({ enabled, reason }),
    }),
  createCampaign: (payload: Record<string, unknown>) =>
    request<{ campaign: Pick<Campaign, "id" | "version"> }>("/campaigns", { method: "POST", body: JSON.stringify(payload) }),
  updateCampaign: (id: string, payload: Record<string, unknown>) =>
    request(`/campaigns/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteCampaign: (id: string) =>
    request(`/campaigns/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createExperiment: (payload: Record<string, unknown>) =>
    request<{ experiment: { id: string } }>("/experiments", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateExperiment: (id: string, payload: Record<string, unknown>) =>
    request<{ experiment: { id: string } }>(`/experiments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  addExperimentVariant: (id: string, payload: Record<string, unknown> = {}) =>
    request<{ variant: { id: string; label: string; name: string | null } }>(`/experiments/${encodeURIComponent(id)}/variants`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateExperimentVariant: (id: string, payload: Record<string, unknown>) =>
    request<{ variant: { id: string; label: string } }>(`/experiment-variants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  createCampaignFolder: (payload: { name: string; position?: number }) =>
    request("/campaign-folders", { method: "POST", body: JSON.stringify(payload) }),
  updateCampaignFolder: (id: string, payload: { name?: string; position?: number }) =>
    request(`/campaign-folders/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCampaignFolder: (id: string) =>
    request(`/campaign-folders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updateProspect: (id: string, payload: Record<string, unknown>) =>
    request(`/prospects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  bulkStatus: (ids: string[], status: string) =>
    request("/prospects/bulk-status", {
      method: "POST",
      body: JSON.stringify({ ids, status }),
    }),
  createExclusion: (payload: Record<string, unknown>) =>
    request("/exclusions", { method: "POST", body: JSON.stringify(payload) }),
  deleteExclusion: (id: string) =>
    request(`/exclusions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  saveGmailAccount: (payload: Record<string, unknown>, id?: string) =>
    request(id ? `/gmail-accounts/${encodeURIComponent(id)}` : "/gmail-accounts", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    }),
  testGmailAccount: (id: string) =>
    request<GmailVerificationResult>(`/gmail-accounts/${encodeURIComponent(id)}/test`, { method: "POST" }),
  sendGmailTestEmail: (id: string, recipient: string) =>
    request<GmailTestSendResult>(`/gmail-accounts/${encodeURIComponent(id)}/test-send`, {
      method: "POST",
      body: JSON.stringify({ recipient }),
    }),
  deleteGmailAccount: (id: string) =>
    request(`/gmail-accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  saveProvider: (payload: Record<string, unknown>, id?: string) =>
    request(id ? `/providers/${encodeURIComponent(id)}` : "/providers", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    }),
  deleteProvider: (id: string) =>
    request(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  saveCredential: (payload: { kind: string; label: string; secret: string; metadata?: Record<string, unknown> }) =>
    request<{ configured: boolean; verificationStatus: string }>("/credentials", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  initializeVault: () =>
    request<{ configured: true; created: boolean; source: "environment" | "netlify_blobs" }>("/vault/initialize", {
      method: "POST",
    }),
  previewImport: (payload: Record<string, unknown>) =>
    request<ImportPreview>("/import/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  commitImport: (payload: Record<string, unknown>) =>
    request<{ imported: number; report: Record<string, number> }>("/import/commit", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  exportData: () => request<Record<string, unknown>>("/export"),
};
