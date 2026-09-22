import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MentionInboxItem } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadExactSessionEntryCandidates } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { CurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { humanMentionDisplayLabel } from "./human-mention-policy.js";
import type { StoredMention } from "./mention-inbox-source-index.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";
import { deriveSessionTitle } from "./session-utils-core.js";

type MentionTargetLookup = { sessionKey: string; agentId?: string };

export function resolveCommittedMentionTarget(
  cfg: OpenClawConfig,
  projection: SessionRowProjection | undefined,
  input: MentionTargetLookup,
): SessionSharingTarget | null {
  if (!projection || isIncognitoSessionKey(input.sessionKey)) {
    return null;
  }
  const selected = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
  if (!selected.ok) {
    return null;
  }
  const row = projection.readCommittedEntry({ agentId: selected.agentId, key: input.sessionKey });
  return row
    ? {
        agentId: row.agentId,
        canonicalKey: row.key,
        entry: row.entry,
        storeKey: row.key,
        storeKeys: [row.key],
        storePath: row.storeTarget.storePath,
      }
    : null;
}

/** Private keys use only an existing process-held database, never durable discovery on a miss. */
export function resolveIncognitoMentionTarget(
  cfg: OpenClawConfig,
  input: MentionTargetLookup,
): SessionSharingTarget | null {
  if (!isIncognitoSessionKey(input.sessionKey)) {
    return null;
  }
  const selected = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
  if (!selected.ok) {
    return null;
  }
  const key = canonicalizeSessionKeyForAgent(selected.agentId, input.sessionKey);
  const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: selected.agentId });
  const entry = loadExactSessionEntryCandidates({
    agentId: selected.agentId,
    storePath,
    sessionKeys: [key],
    readOnly: true,
  })[0]?.entry;
  return entry
    ? {
        agentId: selected.agentId,
        canonicalKey: key,
        entry,
        storeKey: key,
        storeKeys: [key],
        storePath,
      }
    : null;
}

export function projectMentionInboxItem(
  item: StoredMention,
  current: {
    target: { entry: SessionEntry };
    sender?: Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
  },
): MentionInboxItem {
  const { content } = item.message;
  return {
    ...content,
    id: item.id,
    expiresAt: item.source.expiresAt,
    senderProfileId: current.sender?.profileId ?? content.senderProfileId,
    senderLabel: humanMentionDisplayLabel(current.sender?.label, content.senderProfileId),
    ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
    sessionTitle:
      truncateUtf16Safe(
        (deriveSessionTitle(current.target.entry) ?? "Conversation")
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        256,
      ) || "Conversation",
  };
}

export function mentionTargetAccessIdentity(value: SessionSharingTarget | null) {
  return (
    value &&
    JSON.stringify([
      value.agentId,
      value.canonicalKey,
      value.storePath,
      value.entry.sessionId,
      value.entry.lifecycleRevision,
      value.entry.visibility,
      value.entry.incognito,
      value.entry.createdActor,
    ])
  );
}
