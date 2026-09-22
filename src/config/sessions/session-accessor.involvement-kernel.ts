import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { isNewerSessionMention, mergeSessionProfileInvolvement } from "./session-involvement.js";
import type { SessionProfileInvolvement } from "./types.js";
export type SessionInvolvementChange = {
  expectedSessionId: string;
  profileIds: readonly string[];
  aliases: readonly { profileId: string; aliases: readonly string[] }[];
  change:
    | { kind: "visibility"; hidden: boolean }
    | { kind: "mention"; source: NonNullable<SessionProfileInvolvement["lastMention"]> };
};
export function updateSessionProfileInvolvementInDatabase(
  database: OpenClawAgentDatabase,
  resolved: { sessionKey: string },
  params: SessionInvolvementChange,
) {
  const current = readExactSessionEntryRow(database, resolved.sessionKey)?.entry;
  if (!current || current.sessionId !== params.expectedSessionId || current.incognito) {
    return { accepted: false, changed: false };
  }
  const involvement = { ...current.profileInvolvement?.profiles };
  let changed = false;
  for (const profileId of new Set(params.profileIds)) {
    const aliases = params.aliases.find((entry) => entry.profileId === profileId)?.aliases ?? [
      profileId,
    ];
    const previous = mergeSessionProfileInvolvement(
      [...aliases].map((alias) => involvement[alias]),
    );
    const lastMention = previous?.lastMention;
    const change = params.change;
    // Inbox retention cannot turn an old source replay into a fresh mention.
    if (
      change.kind === "mention" &&
      lastMention &&
      !isNewerSessionMention(change.source, lastMention)
    ) {
      continue;
    }
    const hidden = change.kind === "visibility" && change.hidden;
    if (change.kind === "visibility" && previous?.hidden === hidden) {
      continue;
    }
    for (const alias of aliases) {
      delete involvement[alias];
    }
    involvement[profileId] = {
      hidden,
      updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
      ...(change.kind === "mention"
        ? { lastMention: change.source }
        : lastMention
          ? { lastMention }
          : {}),
    };
    changed = true;
  }
  if (changed) {
    writeSessionEntry(database, resolved.sessionKey, current, {
      canonicalPreviousEntry: current,
      profileInvolvement: { key: resolved.sessionKey, profiles: involvement },
    });
  }
  return { accepted: true, changed };
}
