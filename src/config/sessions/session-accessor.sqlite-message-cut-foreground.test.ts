import { expect, it } from "vitest";
import {
  loadSessionEntry,
  rewindSessionToMessage,
  switchSessionBranch,
  replaceSessionEntry,
} from "./session-accessor.js";
import {
  agentId,
  sessionKey,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { readSessionForegroundRun } from "./session-foreground-run.js";

const { createSession } = useSessionMessageCutFixtures();

it.each(["rewind", "switch"] as const)(
  "clears only the previous turn's marker on a committed %s successor",
  async (mode) => {
    const { env, scope } = await createSession();
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error("expected original session");
    }
    await replaceSessionEntry(scope, {
      ...entry,
      foregroundRun: {
        runId: "source-run",
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision ?? null,
        gatewayLifecycleGeneration: "source-gateway",
        deadlineAt: 1000,
      },
    });
    const result =
      mode === "rewind"
        ? await rewindSessionToMessage({ agentId, env, sessionKey, entryId: "user-2" })
        : await switchSessionBranch({ agentId, env, sessionKey, leafEntryId: "off-path-user" });
    expect(result.status).toBe("created");
    const successor = loadSessionEntry(scope);
    expect(successor?.sessionId).not.toBe(scope.sessionId);
    expect(successor).toBeDefined();
    expect(readSessionForegroundRun(successor!)).toEqual({ kind: "absent" });
  },
);
