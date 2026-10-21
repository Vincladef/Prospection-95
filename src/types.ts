export type MessageStatus =
  | "draft"
  | "prepared"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "reserved"
  | "sending"
  | "smtp_accepted"
  | "uncertain"
  | "failed"
  | "cancelled"
  | "received"
  | "sent_manually";

export type CampaignStatus = "inactive" | "active" | "archived";

export interface SequenceContent {
  subject: string;
  steps: [string, string, string, string, string, string];
}

export interface Campaign {
  id: string;
  folderId: string | null;
  name: string;
  status: CampaignStatus;
  targetDescription: string;
  dailyNewContactGoal: number;
  validationPolicy: "manual" | "automatic";
  senderStrategy: "fixed" | "pool";
  fixedSenderAccountId: string | null;
  senderAccountIds: string[];
  aiInstructions: string;
  replyInstructions: string;
  trackingOpensEnabled: boolean;
  trackingClicksEnabled: boolean;
  experimentPolicy: "continue" | "stabilize";
  nextTestInstructions: string;
  importedDisabled: boolean;
  version: number;
  sequence: SequenceContent;
  updatedAt: string;
}

export interface CampaignFolder {
  id: string;
  name: string;
  position: number;
}

export interface Prospect {
  id: string;
  campaignId: string | null;
  campaignName: string | null;
  organizationName: string | null;
  name: string;
  email: string | null;
  contactRaw: string | null;
  website: string | null;
  contactState: string;
  messageStatus: MessageStatus | null;
  step: string | null;
  lastSentAt: string | null;
  senderEmail: string | null;
  alreadyContacted: boolean;
  excluded: boolean;
  exclusionReason: string | null;
  variantLabel: string | null;
  subject: string;
  messages: [string, string, string, string, string, string];
  version: number;
}

export interface GmailAccount {
  id: string;
  email: string;
  displayName: string | null;
  role: "sender" | "primary" | "test_inbox";
  status: "configuring" | "active" | "suspended" | "error" | "deleted";
  hasCredential: boolean;
  dailyLimit: number;
  warmupDailyLimit: number | null;
  sendDays: number[];
  sendStart: string;
  sendEnd: string;
  timezone: string;
  randomizeSendTimes: boolean;
  progressiveRampEnabled: boolean;
  pausedAt: string | null;
  pauseSource: string | null;
  pauseReason: string | null;
  smtpVerifiedAt: string | null;
  imapVerifiedAt: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  version: number;
}

export interface DeliverabilityProvider {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  needsTestEmail: boolean;
  capability: string;
  quotaScope: string;
  quotaConfidence: "documented" | "observed" | "estimated" | "unknown";
  nextEligibleAt: string | null;
  lastUsedAt: string | null;
}

export interface ExperimentVariant {
  id: string;
  label: string;
  allocationWeight: number;
  overrides: Partial<SequenceContent> & Record<string, unknown>;
  assignedCount: number;
  sentCount: number;
  humanReplyCount: number;
  positiveReplyCount: number;
  confirmedMeetingCount: number;
}

export interface Experiment {
  id: string;
  campaignId: string;
  name: string;
  status: string;
  thresholdContactsPerVariant: number;
  thresholdReplies: number;
  variants: ExperimentVariant[];
}

export interface AppSettings {
  timezone: string;
  outboundEnabled: boolean;
  vaultConfigured: boolean;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
  generalWritingInstructions: string;
  defaultSendDays: number[];
  defaultSendStart: string;
  defaultSendEnd: string;
  version: number;
}

export interface DashboardData {
  settings: AppSettings;
  folders: CampaignFolder[];
  campaigns: Campaign[];
  prospects: Prospect[];
  gmailAccounts: GmailAccount[];
  providers: DeliverabilityProvider[];
  experiments: Experiment[];
  totals: {
    prospects: number;
    pendingApproval: number;
    scheduled: number;
    sent: number;
    replied: number;
    excluded: number;
  };
}

export interface ApiErrorPayload {
  error?: string;
  message?: string;
  code?: string;
  details?: unknown;
}

export interface ImportPreview {
  importId?: string;
  rows: number;
  campaigns: number;
  validEmails: number;
  nonEmailContacts: number;
  exclusions: number;
  alreadyContacted: number;
  duplicates: number;
  warnings: string[];
}
