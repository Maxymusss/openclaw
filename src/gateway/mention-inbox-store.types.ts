import type { MentionAudienceIdentity } from "./mention-inbox-audience-schema.js";

/** Stored source shapes are shared by the SQLite owner and its worker messages. */
export type MentionStoreHead = { revision: number; nextSequence: number };
export type MentionStoreMessage = {
  sessionId: string;
  content: {
    senderProfileId: string;
    sessionKey: string;
    agentId: string;
    messageId: string;
    createdAt: number;
    excerpt?: string;
  };
};
export type MentionStoreSource = {
  key: string;
  sequence: number;
  expiresAt: number;
  recipients: [string, string | null][];
  message?: MentionStoreMessage;
};
export type MentionStoreSnapshot = {
  head: MentionStoreHead;
  sources: MentionStoreSource[];
};

export type MentionAudienceReceipt = MentionAudienceIdentity & {
  createdAt: number;
  recipients: string[];
};
export type MentionAudienceCleanupCandidate = {
  state_key: string;
  value_json: string;
  updated_at_ms: number;
  receipt: MentionAudienceReceipt;
};
export type MentionAudienceCleanup = Array<MentionAudienceCleanupCandidate & { retained: boolean }>;
