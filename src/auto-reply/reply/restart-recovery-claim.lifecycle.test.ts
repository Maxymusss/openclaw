import { expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createAgentRunStaleLifecycleError } from "../../infra/agent-lifecycle-error.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { handleReplyAgentRunError } from "./agent-runner-core.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

async function withTrackedReply(
  test: (fixture: {
    controller: ReturnType<typeof createReplyRestartRecoveryClaimController>;
    operation: ReplyOperation;
    confirmArmed: () => Promise<void>;
    replaceWithSuccessor: () => Promise<void>;
    readEntry: () => ReturnType<typeof loadSessionEntry>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:retired-readiness",
      storePath: state.statePath("sessions.json"),
    };
    let entry: InternalSessionEntry = {
      sessionId: "old-session",
      updatedAt: 1,
      status: "running",
      restartRecoveryDeliveryRunId: "old-recovery",
    };
    await replaceSessionEntry(scope, entry);
    const operation = createReplyOperation({
      ...scope,
      sessionId: entry.sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    const controller = createReplyRestartRecoveryClaimController({
      ...scope,
      admissionRunId: "old-recovery",
      lifecycleGeneration: operation.lifecycleGeneration,
      getEntry: () => entry,
      getSessionId: () => operation.sessionId,
      isRestartAbort: () =>
        operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart",
      resolveDeliveryContext: () => undefined,
      setEntry: (value) => {
        entry = value;
      },
    });
    try {
      await controller.admitUserTurn();
      await test({
        controller,
        operation,
        async confirmArmed() {
          entry = { ...entry, abortedLastRun: true };
          await replaceSessionEntry(scope, entry);
          expect(await controller.isArmed()).toBe(true);
        },
        async replaceWithSuccessor() {
          entry = {
            sessionId: "successor-session",
            updatedAt: 2,
            status: "running",
            abortedLastRun: true,
            restartRecoveryDeliveryRunId: "successor-recovery",
          };
          await replaceSessionEntry(scope, entry);
        },
        readEntry: () => loadSessionEntry(scope),
      });
    } finally {
      operation.complete();
    }
  });
}

it.each([
  { stage: "before-read", confirmed: false },
  { stage: "before-read", confirmed: true },
  { stage: "during-read", confirmed: false },
  { stage: "during-read", confirmed: true },
] as const)(
  "settles retired restart readiness without adopting successor facts ($stage, confirmed=$confirmed)",
  async ({ stage, confirmed }) => {
    await withTrackedReply(
      async ({ controller, operation, confirmArmed, replaceWithSuccessor, readEntry }) => {
        if (confirmed) {
          await confirmArmed();
        }
        const read = entryReads.readSessionEntryInWorker;
        const reads = vi.spyOn(entryReads, "readSessionEntryInWorker");
        let drains = 0;
        try {
          operation.abortForRestart();
          if (stage === "before-read") {
            rotateAgentEventLifecycleGeneration();
            await replaceWithSuccessor();
          } else {
            reads.mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              rotateAgentEventLifecycleGeneration();
              await replaceWithSuccessor();
              return result;
            });
          }
          const reply = await handleReplyAgentRunError(new Error("Backend stopped"), {
            resolveVisibleReplyDelivery: async () => false,
            isHeartbeat: false,
            replyExpectation: "required",
            isRestartRecoveryArmed: controller.isArmed,
            replyOperation: operation,
            resolvedVerboseLevel: "off",
            returnWithQueuedFollowupDrain: (value) => {
              drains += 1;
              return value;
            },
            sessionCtx: {},
          });
          expect(reply?.text).toBe(
            confirmed
              ? SILENT_REPLY_TOKEN
              : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
          );
          expect(drains).toBe(1);
          expect(reads).toHaveBeenCalledTimes(stage === "before-read" ? 0 : 1);
          expect(readEntry()).toMatchObject({
            sessionId: "successor-session",
            restartRecoveryDeliveryRunId: "successor-recovery",
            abortedLastRun: true,
          });
        } finally {
          reads.mockRestore();
        }
      },
    );
  },
);

it.each(["active-storage", "retired-storage", "retired-cleanup"] as const)(
  "preserves readiness failures outside the retired lifecycle refusal (%s)",
  async (failure) => {
    await withTrackedReply(async ({ controller, operation }) => {
      const storageError = new Error("Storage unavailable");
      const staleError = createAgentRunStaleLifecycleError();
      const expected =
        failure === "retired-cleanup"
          ? createSqliteLifecycleAggregateError(
              [staleError, storageError],
              "Read and cleanup failed",
              staleError,
            )
          : storageError;
      const reads = vi
        .spyOn(entryReads, "readSessionEntryInWorker")
        .mockImplementationOnce(async () => {
          if (failure !== "active-storage") {
            rotateAgentEventLifecycleGeneration();
          }
          throw expected;
        });
      try {
        operation.abortForRestart();
        await expect(controller.isArmed()).rejects.toBe(expected);
      } finally {
        reads.mockRestore();
      }
    });
  },
);
