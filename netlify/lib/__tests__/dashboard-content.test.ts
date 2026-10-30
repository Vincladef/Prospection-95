import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prospect } from "../../../src/types";
import { loadDashboard } from "../dashboard.mts";

const mocks = vi.hoisted(() => ({ sqlQuery: vi.fn() }));
vi.mock("../db.mts", () => mocks);
vi.mock("../credentials.mts", () => ({ credentialVaultConfigured: async () => true }));

const sequence = (pass: string) => ({ subject: `Objet ${pass}`, steps: [0, 1, 2, 3, 4, 5].map((i) => `${pass} étape ${i}`) });
let rows: Record<string, unknown>[];
let messages: Record<string, unknown>[];
async function displayed() { return (await loadDashboard()).prospects as Prospect[]; }

beforeEach(() => {
  rows = [{ id: "p1", campaign_id: "c1", output_sequence: sequence("passe 1"), iteration_completed_at: "2026-10-29T09:00:00Z", writing_iterations_completed: 1, writing_iterations_total: 5 }];
  messages = [];
  mocks.sqlQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("select p.id::text")) return rows;
    if (sql.includes("select distinct on (conv.campaign_id")) return messages;
    if (sql.includes("select distinct on (campaign_id, step)")) return [{ campaign_id: "c1", step: "J0", subject: "Modèle générique", body: "Texte générique" }];
    return [];
  });
});

describe("prospect content displayed by dashboard", () => {
  it("shows every intermediate pass before final messages exist", async () => {
    for (const pass of [1, 2, 3, 4, 5]) {
      rows[0].output_sequence = sequence(`passe ${pass}`);
      rows[0].writing_iterations_completed = pass;
      const [p] = await displayed();
      expect(p.subject).toBe(`Objet passe ${pass}`);
      expect(p.messages).toEqual(sequence(`passe ${pass}`).steps);
      expect(p.writingIterationsCompleted).toBe(pass);
    }
  });

  it("never replaces missing personalized content with campaign templates", async () => {
    rows[0].output_sequence = null;
    const [p] = await displayed();
    expect(p.subject).toBe("");
    expect(p.messages).toEqual(["", "", "", "", "", ""]);
  });

  it("keeps later manual or plugin revisions and the existing draft status", async () => {
    rows[0].message_status = "draft";
    messages = sequence("révision").steps.map((body, i) => ({ campaign_id: "c1", prospect_id: "p1", step: ["J0", "R1", "R2", "R3", "R4", "R5"][i], subject: "Objet modifié", body_text: body, created_at: "2026-10-29T10:00:00Z", content_version: 6, status: "draft" }));
    const [p] = await displayed();
    expect(p.subject).toBe("Objet modifié");
    expect(p.messages).toEqual(sequence("révision").steps);
    expect(p.messageStatus).toBe("draft");
  });

  it("uses a newer iteration instead of older generated content and isolates campaigns", async () => {
    messages = [
      { campaign_id: "c1", prospect_id: "p1", step: "J0", subject: "Ancien", body_text: "Ancien", created_at: "2026-10-28T10:00:00Z" },
      { campaign_id: "other", prospect_id: "p1", step: "R1", subject: "Autre", body_text: "Autre campagne", created_at: "2026-10-30T10:00:00Z" },
    ];
    const [p] = await displayed();
    expect(p.subject).toBe("Objet passe 1");
    expect(p.messages).toEqual(sequence("passe 1").steps);
  });

  it("derives the displayed status from current step versions and retains the sent date", async () => {
    rows[0].message_status = "draft";
    messages = [
      { campaign_id: "c1", prospect_id: "p1", step: "J0", content_version: 6, status: "smtp_accepted", technical_confirmation: true, smtp_accepted_at: "2026-10-29T15:25:12.158Z" },
      { campaign_id: "c1", prospect_id: "p1", step: "R1", content_version: 6, status: "scheduled" },
    ];
    const [p] = await displayed();
    expect(p.messageStatus).toBe("scheduled");
    expect(p.statusStep).toBe("R1");
    expect(p.lastSentStep).toBe("J0");
    expect(p.lastSentAt).toBe("2026-10-29T15:25:12.158Z");
  });

  it("keeps sent and in-flight content authoritative even with a newer output", async () => {
    for (const status of ["smtp_accepted", "sending", "reserved", "uncertain", "sent_manually"]) {
      messages = [{ campaign_id: "c1", prospect_id: "p1", step: "J0", subject: "Objet envoyé", body_text: "Texte envoyé", created_at: "2026-10-28T10:00:00Z", status }];
      expect((await displayed())[0].messages[0]).toBe("Texte envoyé");
    }
  });
});
