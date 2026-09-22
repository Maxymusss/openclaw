import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resetReplyRunSession } from "./agent-runner-session-reset.js";
import { setAgentRunnerSessionResetTestDeps } from "./agent-runner-session-reset.test-support.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => setAgentRunnerSessionResetTestDeps());

it("stops automatic repair before rotating the exact foreground admission", async () => {
  const sessionKey = "agent:main:foreground-reset";
  const storePath = path.join(tempDirs.make("openclaw-foreground-reset-"), "sessions.json");
  const entry: InternalSessionEntry = {
    sessionId: "original-session",
    lifecycleRevision: "original-revision",
    updatedAt: 1,
    foregroundRun: {
      runId: "original-run",
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
      gatewayLifecycleGeneration: "original-gateway",
      deadlineAt: Date.now() + 10000,
    },
  };
  await replaceSessionEntry({ sessionKey, storePath }, entry);
  const before = loadSessionEntry({ sessionKey, storePath });
  const followupRun = createTestFollowupRun();
  followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "original-person",
    scopes: ["operator.sessions.write"],
    executionPolicy: "foreground-only",
    assertCurrent() {},
  });
  const effects = vi.fn();
  setAgentRunnerSessionResetTestDeps({
    generateSecureUuid: effects,
    resetRegisteredAgentHarnessSessions: effects,
  });
  await expect(
    resetReplyRunSession({
      options: {
        failureLabel: "role ordering conflict",
        buildLogMessage: () => "unexpected reset",
      },
      sessionKey,
      queueKey: sessionKey,
      activeSessionStore: { [sessionKey]: entry },
      storePath,
      followupRun,
      onActiveSessionEntry: effects,
      onNewSession: effects,
    }),
  ).rejects.toThrow("Start a new thread");
  expect(effects).not.toHaveBeenCalled();
  expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before);
});
