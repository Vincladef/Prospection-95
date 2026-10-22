import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      close: mocks.close,
      sendMail: mocks.sendMail,
    })),
  },
}));

vi.mock("../credentials.mts", () => ({
  readCredential: vi.fn(async () => ({ kind: "gmail_sender", secret: "abcd efgh ijkl mnop" })),
}));

vi.mock("../auth.mts", () => ({
  isProductionOutboundEnabled: vi.fn(() => false),
}));

import { sendGmailDiagnostic, sendGmailMessage } from "../gmail.mts";

describe("Gmail diagnostic send", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.sendMail.mockReset();
    mocks.sendMail.mockResolvedValue({
      accepted: ["test@example.com"],
      rejected: [],
      messageId: "<diagnostic@example.com>",
      response: "250 2.0.0 OK",
    });
  });

  it("allows one explicit diagnostic while campaign outbound remains disabled", async () => {
    await expect(sendGmailMessage({
      fromEmail: "sender@gmail.com",
      credentialId: "credential-id",
      recipient: "prospect@example.com",
      subject: "Commercial",
      text: "Message",
      messageId: "commercial-id",
    })).rejects.toMatchObject({ code: "outbound_disabled" });

    const result = await sendGmailDiagnostic({
      email: "sender@gmail.com",
      credentialId: "credential-id",
      recipient: "test@example.com",
    });

    expect(result).toMatchObject({ state: "accepted", messageId: "<diagnostic@example.com>" });
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "test@example.com",
      subject: "Test d’envoi Prospection 95",
      headers: { "X-Prospection95-Diagnostic": "manual-test" },
    }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
