import type { MentionAudienceIdentity } from "./mention-inbox-audience-schema.js";
import type {
  MentionAudienceCleanup,
  MentionAudienceCleanupCandidate,
  MentionAudienceReceipt,
  MentionStoreSnapshot,
} from "./mention-inbox-store.types.js";

export type MentionCommittedInput = {
  sourceId: string;
  committedSource: { generation: string; sequence: number; timestamp: number };
  sessionKey: string;
  agentId?: string;
  sessionId: string;
  messageId: string;
  senderProfileId: string;
  recipientProfileIds: readonly string[];
  excerpt?: string;
  /** Exact private source custody; only a retained everyone token permits its fanout. */
  everyoneAudience?: { identity: MentionAudienceIdentity; retained: boolean };
};

export type MentionReadInput = {
  revision: number;
  now: number;
  identity?: MentionAudienceIdentity;
  cleanup?: boolean;
};
export type MentionReadResult = {
  snapshot?: MentionStoreSnapshot;
  audience?: MentionAudienceReceipt;
  audienceExpiryAt: number;
  cleanup: MentionAudienceCleanupCandidate[];
};
type MentionMutation =
  | { kind: "maintain"; cleanup: MentionAudienceCleanup }
  | {
      kind: "retain";
      identity: MentionAudienceIdentity;
      recipients?: readonly string[];
      recovered: boolean;
    }
  | { kind: "dismiss"; ids: readonly string[]; profileId: string }
  | {
      kind: "commit";
      input: MentionCommittedInput;
      audience?: MentionAudienceReceipt;
      target?: { agentId: string; sessionKey: string; senderProfileId: string };
      recipients: readonly string[];
      allowed: readonly string[];
      excerpt?: string;
    };
export type MentionWorkerOperations = {
  "mentions.mutate": {
    input: { revision: number; now: number; operation: MentionMutation };
    output: {
      snapshot?: MentionStoreSnapshot;
      audienceExpiryAt: number;
      createdIds: string[];
      capacityReached: boolean;
    };
  };
};
