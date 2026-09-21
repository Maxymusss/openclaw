import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import type { AcpSessionEntryBinding } from "./session-meta-keys.js";
import {
  readAcpSessionMetaForEntryInDatabase,
  type AcpSessionMetaEntryRead,
} from "./session-meta-readonly.kernel.js";
export { rowToAcpSessionMeta } from "./session-meta-readonly.kernel.js";

export function readAcpSessionMetaForEntry(
  params: AcpSessionMetaEntryRead & {
    cfg?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    databasePath?: string;
  },
): SessionAcpMeta | undefined {
  if (!params.sessionKey.trim()) {
    return undefined;
  }
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => readAcpSessionMetaForEntryInDatabase(db, params),
    { env: params.env, path: params.databasePath },
  );
}

/** Prepared metadata belongs to these exact entry lifecycles, never a later row at the same key. */
export async function readAcpSessionMetaForEntriesInWorker(params: {
  entries: readonly (Omit<AcpSessionMetaEntryRead, "entry"> & {
    entry: AcpSessionEntryBinding & { acp?: SessionAcpMeta };
  })[];
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): Promise<Array<SessionAcpMeta | undefined>> {
  const pending: AcpSessionMetaEntryRead[] = [];
  const result = params.entries.map(({ sessionKey, agentId, entry }) => {
    if (!entry.acp) {
      pending.push({
        sessionKey,
        agentId,
        entry: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          sessionStartedAt: entry.sessionStartedAt,
        },
      });
    }
    return entry.acp;
  });
  if (!pending.length) {
    return result;
  }
  const reply = await executeExistingOpenClawStateRead(
    { env: params.env, path: params.databasePath },
    { type: "acpSessionMeta.entries", entries: pending, cfg: params.cfg },
  );
  if (!reply) {
    return result;
  }
  if (!reply.ok || reply.type !== "acpSessionMeta.entries") {
    throw new Error("Unexpected ACP session metadata read result");
  }
  let index = 0;
  return result.map((meta) => meta ?? reply.metadata[index++]);
}
