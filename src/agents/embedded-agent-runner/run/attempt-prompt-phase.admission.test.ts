import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolveDefaultSessionStorePath } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import type { PromptSubmissionCall } from "./attempt-prompt-phase.test-support.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);
const tempStateDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyPromptToolsAllow.mockReturnValue({
    activeToolNames: ["read"],
    callableToolNames: ["read"],
    effectiveTools: [{ name: "read" }],
    uncompactedEffectiveTools: [{ name: "read" }],
    tools: [{ name: "read" }],
  });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

describe("prompt projection write admission", () => {
  it.each([false, true])(
    "pins the image environment across an await (retired: %s)",
    async (retired) => {
      const fixture = createFixture();
      const original = new AbortController();
      const reason = new Error("image generation retired");
      const assertOriginal = vi.fn(() => original.signal.throwIfAborted());
      const environment = { sandbox: null, assertCurrent: assertOriginal };
      fixture.readEnvironment.mockImplementation(() => {
        environment.assertCurrent();
        return environment;
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepareImages = mocks.preparePromptExecution.getMockImplementation();
      if (!prepareImages) {
        throw new Error("Missing image preparation fixture");
      }
      mocks.preparePromptExecution.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return prepareImages(...args);
      });
      const pending = runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Prompt phase settled before image preparation");
          }),
        ]);
        const assertSuccessor = vi.fn();
        fixture.readEnvironment.mockReturnValue({ sandbox: null, assertCurrent: assertSuccessor });
        if (retired) {
          original.abort(reason);
        }
        release.resolve();
        await pending;
        expect(fixture.readEnvironment).toHaveBeenCalledOnce();
        expect(assertOriginal).toHaveBeenCalledTimes(2);
        expect(assertSuccessor).not.toHaveBeenCalled();
        if (retired) {
          expect(mocks.handlePromptError).toHaveBeenCalledWith(
            expect.objectContaining({ error: reason }),
          );
          expect(mocks.observePrompt).not.toHaveBeenCalled();
          expect(mocks.submitPrompt).not.toHaveBeenCalled();
        } else {
          expect(mocks.handlePromptError).not.toHaveBeenCalled();
          expect(mocks.submitPrompt).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each([false, true])(
    "admits projection persistence before provider dispatch and rechecks cancellation (abort: %s)",
    async (abort) => {
      const stateDir = tempStateDirs.make("openclaw-prompt-projection-admission-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:projection-admission",
        sessionId: "projection-admission",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope);
      const fixture = createFixture();
      fixture.input.prepared.sessionRuntime.sessionManager = manager;
      const projection = createToolResultPromptProjectionState();
      projection.frozen.add("tool-result");
      projection.sourceHashByKey.set("tool-result", "source");
      projection.replacements.set("tool-result", {
        content: [{ type: "text", text: "bounded result" }],
      });
      fixture.input.prepared.sessionRuntime.toolResultPromptProjectionState = projection;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const requested = createDeferredCore();
      const worker = runOpenClawAgentWorkerWrite({ agentId: scope.agentId }, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let dispatched = false;
      mocks.submitPrompt.mockImplementation(async (submission: PromptSubmissionCall) => {
        requested.resolve();
        await submission.persistToolResultProjections();
        dispatched = true;
      });
      const markers = () => manager.getEntries().filter((entry) => entry.type === "custom");
      const phase = runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
      try {
        await requested.promise;
        await yieldToEventLoop();
        expect(markers()).toEqual([]);
        expect(dispatched).toBe(false);
        const reason = new Error("attempt cancelled while waiting for database");
        if (abort) {
          fixture.input.runAbortController.abort(reason);
        }
        release.resolve();
        await Promise.all([worker, phase]);
        if (abort) {
          expect(markers()).toEqual([]);
          expect(dispatched).toBe(false);
          expect(mocks.handlePromptError).toHaveBeenCalledWith(
            expect.objectContaining({ error: reason }),
          );
        } else {
          expect(markers()).toMatchObject([{ customType: "openclaw.cache-ttl" }]);
          expect(dispatched).toBe(true);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([worker, phase]);
      }
    },
  );
});
