import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { readUserProfileAliases } from "../../state/user-profiles.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { updateSessionProfileInvolvementInDatabase } from "./session-accessor.involvement-kernel.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionInputCustodyWorker } from "./session-input-custody-worker.js";
import type { SessionProfileInvolvement } from "./types.js";

/** One logical-node owner for explicit personal choices and committed mentions. */
export function updateSessionProfileInvolvement(
  scope: SessionAccessScope,
  params: {
    expectedSessionId: string;
    profileIds: readonly string[];
    change:
      | { kind: "visibility"; hidden: boolean }
      | { kind: "mention"; source: NonNullable<SessionProfileInvolvement["lastMention"]> };
    assertCurrent?: () => void;
  },
): boolean {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction(
    (database) => {
      params.assertCurrent?.();
      const result = updateSessionProfileInvolvementInDatabase(database, resolved, {
        ...params,
        aliases: [...new Set(params.profileIds)].map((profileId) => ({
          profileId,
          aliases: [...readUserProfileAliases(profileId, { env: scope.env })],
        })),
      });
      if (result.changed) {
        deferOpenClawAgentPostCommitPublication(database, () =>
          emitSessionLifecycleEvent({
            agentId: resolved.agentId,
            sessionKey: resolved.sessionKey,
            reason: "involvement",
          }),
        );
      }
      return result.accepted;
    },
    toDatabaseOptions(resolved),
    { operationLabel: "sessions.involvement" },
  );
}

/** Mention publication awaits durable agent state; personal visibility keeps its native owner. */
export async function updateSessionMentionProfileInvolvement(
  scope: SessionAccessScope,
  input: {
    expectedSessionId: string;
    profileIds: readonly string[];
    source: NonNullable<SessionProfileInvolvement["lastMention"]>;
  },
  assertCurrent: () => void = () => {},
): Promise<boolean> {
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...scope, env });
  const selectedDatabase = toDatabaseOptions(resolved);
  const options = { ...selectedDatabase, path: resolveOpenClawAgentSqlitePath(selectedDatabase) };
  const params = structuredClone(input);
  // Alias authority stays with the live profile owner, not a copied worker catalog.
  const aliases = [...new Set(params.profileIds)].map((profileId) => ({
    profileId,
    aliases: [...readUserProfileAliases(profileId, { env })],
  }));
  const assert = () => {
    assertCurrent();
    for (const entry of aliases) {
      const current = readUserProfileAliases(entry.profileId, { env });
      if (
        current.size !== entry.aliases.length ||
        entry.aliases.some((alias) => !current.has(alias))
      ) {
        throw new Error("Mention profile aliases changed before involvement commit");
      }
    }
  };
  const worker = captureSessionInputCustodyWorker(options);
  try {
    const result = await worker.run(
      {
        type: "mention",
        input: {
          sessionKey: resolved.sessionKey,
          params: {
            ...params,
            aliases,
            change: { kind: "mention", source: params.source },
          },
        },
      },
      assert,
    );
    if (result.changed) {
      const database = getOpenClawAgentDatabaseIfOpen(options);
      if (database) {
        publishSessionEntryCacheInvalidation(database, { sessionKey: resolved.sessionKey });
      } else {
        sessionChanges.emit({
          agentId: resolved.agentId,
          storePath: resolveOpenClawAgentSqlitePath(options),
          sessionKey: resolved.sessionKey,
        });
      }
      emitSessionLifecycleEvent({
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        reason: "involvement",
      });
    }
    return result.accepted;
  } finally {
    await worker.release();
  }
}
