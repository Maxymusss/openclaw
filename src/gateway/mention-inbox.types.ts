import type { Result } from "@openclaw/normalization-core/result";
import type {
  ErrorShape,
  MentionsListResult,
  UsersMentionableParams,
  UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { MentionAudienceIdentity } from "./mention-inbox-audience-schema.js";
import type { MentionCommittedInput } from "./mention-inbox-worker-contract.js";
import type { GatewayClient } from "./server-methods/client-types.js";

/** Keep the Gateway context independent of its context-consuming Inbox implementation. */
export type MentionInbox = {
  mentionable: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    publish: (result: Result<UsersMentionableResult, ErrorShape>) => undefined,
  ) => Promise<void>;
  validateRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
    profileIds: readonly string[],
  ) => Result<readonly string[], ErrorShape>;
  /** Prepare committed target facts, and the bounded roster only for fresh everyone selection. */
  prepareRecipients: (everyone: boolean) => Promise<Result<undefined, ErrorShape>>;
  resolveEveryoneRecipients: (
    client: GatewayClient | null,
    input: UsersMentionableParams,
  ) => Result<readonly string[], ErrorShape>;
  retainEveryoneAudience: (
    client: GatewayClient | null,
    identity: MentionAudienceIdentity,
    options: { assertCurrent: () => void } & (
      | { recipients: readonly string[]; recovered: boolean }
      | { recovered: true }
    ),
  ) => Promise<void>;
  list: (
    client: GatewayClient | null,
    publish: (result: Result<MentionsListResult, ErrorShape>) => void,
  ) => Promise<void>;
  dismiss: (
    client: GatewayClient | null,
    ids: readonly string[],
    publish: (result: Result<MentionsListResult, ErrorShape>) => void,
  ) => Promise<void>;
  /** Reserve postcommit custody synchronously before a collected source starts yielding. */
  reserveCommittedInput: () => (complete: () => Promise<void>) => Promise<void>;
  recordCommittedInput: (input: MentionCommittedInput) => Promise<void>;
  invalidate: (sessionKey?: string) => void;
  dispose: () => Promise<void>;
};
