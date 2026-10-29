import { getAccessToken } from "./auth";
import type { ApiErrorPayload, BlacklistPage, Campaign, DashboardData, GmailTestSendResult, GmailVerificationResult, ImportPreview } from "../types";

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
  const jsonBody = init.body !== undefined && !(init.body instanceof FormData);
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as T & ApiErrorPayload;
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export const api = {
  dashboard: () => request<DashboardData>("/dashboard"),
  blacklist: (query: string, page: number, signal?: AbortSignal) =>
    request<BlacklistPage>(`/exclusions?${new URLSearchParams({ q: query, page: String(page) })}`, { signal }),
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
  moveCampaignToFolder: (id: string, folderId: string | null, version: number) =>
    request<{ campaign: Pick<Campaign, "id" | "version"> }>(`/campaigns/${encodeURIComponent(id)}/folder`, {
      method: "PATCH",
      body: JSON.stringify({ folderId, version }),
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
  syncBobwork: () =>
    request<{ ok: true; records: number; resources: string[]; observedAt: string | null }>("/bobwork/sync", { method: "POST" }),
  uploadInstructionAttachment: (input: { file: File; scope: "global" | "campaign"; campaignId?: string | null; fieldKey: string }) => {
    const form = new FormData();
    form.set("file", input.file);
    form.set("scope", input.scope);
    form.set("fieldKey", input.fieldKey);
    if (input.campaignId) form.set("campaignId", input.campaignId);
    return request<{ attachment: { id: string } }>("/instruction-attachments", { method: "POST", body: form });
  },
  deleteInstructionAttachment: (id: string) =>
    request(`/instruction-attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  downloadInstructionAttachment: async (id: string, filename: string) => {
    const token = await getAccessToken();
    const response = await fetch(`/api/instruction-attachments/${encodeURIComponent(id)}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ApiErrorPayload;
      throw new ApiError(response.status, body);
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  },
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
