import type { SessionAccessScope } from "../config/sessions/session-accessor.js";
import { publishSessionSharingMemberChange } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { removeSessionMemberInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";

// Fault-injection callbacks must finish revocation before execution resumes.
export function revokeSessionMemberForTest(
  scope: SessionAccessScope,
  identityId: string,
  expectedSessionId: string,
) {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction((database) => {
    const removed = removeSessionMemberInDatabase(
      database,
      resolved.sessionKey,
      identityId,
      undefined,
      expectedSessionId,
    );
    if (removed) {
      publishSessionSharingMemberChange(
        database,
        resolved.sessionKey,
        { identityId: removed.identityId, present: false },
        resolved.agentId,
      );
    }
    return removed;
  }, toDatabaseOptions(resolved));
}
