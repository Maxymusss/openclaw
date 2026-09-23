import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  blockSubagentCompletionDelivery,
  publishCommittedRecords,
  settleRequesterCompletionBatch,
  settleSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.store.js";
import {
  failedRecords,
  records,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  leasePendingAgentSteeringItems,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  resetSubagentRegistryForTests({ persist: false });
  testing.setDepsForTest({ getRuntimeConfig: () => ({}) });
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  resetHeartbeatEventsForTest();
  testing.setDepsForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([false, true])(
  "suspends an original-store child that completes after replacement without a new alert (overlapping new-store wake: %s)",
  async (overlappingWake) => {
    const input = records();
    const now = Date.now();
    let replacementWake: typeof input.subagent.requesterSettleWake;
    if (overlappingWake) {
      input.subagent.execution.endedAt = now + 2_000;
    }
    input.subagent.requesterStorePath = "original-store";
    input.subagent.delivery = {
      status: "pending",
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    input.subagent.requesterSettleWake = overlappingWake
      ? { status: "pending", attemptCount: 0 }
      : {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [input.subagent.runId],
        };
    const running = structuredClone(input);
    running.subagent.execution = { status: "running", startedAt: input.subagent.createdAt };
    running.subagent.completion = { required: true };
    const database = openOpenClawStateDatabase();
    settleSubagentCompletionDelivery({ subagent: running.subagent });
    publishCommittedRecords(running.subagent);
    publishSystemEventStoreResolver(() => "replacement-store");
    expect(subagentRuns.get(input.subagent.runId)?.execution.status).toBe("running");

    if (overlappingWake) {
      vi.setSystemTime(now + 1_000);
      const replacement = records();
      replacement.subagent.taskRunId = "replacement-task-run";
      replacement.subagent.childSessionKey = "agent:main:subagent:replacement";
      replacement.subagent.createdAt = now + 1_000;
      replacement.subagent.execution.endedAt = now + 1_500;
      replacement.subagent.runId = "replacement-run";

      replacement.subagent.requesterStorePath = "replacement-store";
      replacement.subagent.delivery = { status: "pending" };
      settleSubagentCompletionDelivery({ subagent: replacement.subagent });
      publishCommittedRecords(replacement.subagent);
      expect(
        blockSubagentCompletionDelivery({
          subagent: expectDefined(subagentRuns.get(replacement.subagent.runId), "new-store child"),
          reason: "completion delivery expired",
          suspendedReason: "expiry",
        }),
      ).toBe(true);
      replacementWake = structuredClone(
        subagentRuns.get(replacement.subagent.runId)?.requesterSettleWake,
      );
      expect(replacementWake).toMatchObject({ status: "pending" });
      vi.setSystemTime(now + 2_000);
    }

    settleSubagentCompletionDelivery({ subagent: input.subagent });
    publishCommittedRecords(input.subagent);
    const settledEntry = expectDefined(
      subagentRuns.get(input.subagent.runId),
      "late terminal child",
    );
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: input.subagent.requesterSessionKey,
        settledEntry,
        transitionBatch: () => {
          throw new Error("a replaced store must not admit a delivery attempt");
        },
        completeBatch: (batch, _generation, outcome, onCommitted) => {
          settleRequesterCompletionBatch({
            entries: batch.map((subagent) => ({
              subagent,
            })),
            outcome: expectDefined(outcome, "store replacement disposition"),
            isCurrent: () => batch.every((entry) => subagentRuns.get(entry.runId) === entry),
          });
          onCommitted?.();
        },
      }),
    ).toBe(false);
    if (overlappingWake) {
      expect(loadSubagentRegistryFromSqlite().get("replacement-run")?.requesterSettleWake).toEqual(
        replacementWake,
      );
    }
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toMatchObject({
      completion: { resultText: "canonical result" },
      delivery: {
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
      },
    });
  },
);

it.each(["same", "replaced", "restore", "unknown", "failed", "delivered"] as const)(
  "keeps automatic child notification disposition through store publication: %s",
  async (change) => {
    const input = change === "failed" ? failedRecords("failed", { status: "error" }) : records();
    input.subagent.requesterStorePath = change === "unknown" ? undefined : "original-store";
    input.subagent.controllerStorePath = change === "unknown" ? undefined : "original-store";
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = {
      status: change === "delivered" ? "delivered" : "pending",
      ...(change === "delivered" ? { deliveredAt: Date.now(), announcedAt: Date.now() } : {}),
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    const executionBefore = structuredClone(input.subagent.execution);
    const database = openOpenClawStateDatabase();
    settleSubagentCompletionDelivery({ subagent: input.subagent });
    const receipt = expectDefined(
      loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery,
      "persisted notification receipt",
    );
    subagentRuns.set(input.subagent.runId, input.subagent);
    initSubagentRegistry();
    if (change === "restore") {
      resetSubagentRegistryForTests({ persist: false });
      publishSystemEventStoreResolver(() => "replacement-store");
      initSubagentRegistry();
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      activateSubagentRegistry(() => context);
    } else {
      publishSystemEventStoreResolver(() =>
        change === "same" || change === "unknown" ? "original-store" : "replacement-store",
      );
    }
    publishSystemEventStoreResolver(() => "original-store");
    const persisted = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
    if (change === "unknown") {
      expect(persisted?.requesterStorePath).toBeUndefined();
      expect(persisted?.controllerStorePath).toBeUndefined();
    }
    expect(persisted?.completion?.resultText).toBe(input.subagent.completion?.resultText);
    expect(persisted?.execution).toEqual(executionBefore);
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    if (change === "delivered") {
      expect(persisted?.delivery).toEqual(receipt);
    } else if (change !== "same") {
      expect(persisted?.delivery).toMatchObject({
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
        payload: receipt.payload,
      });
      expect(persisted?.requesterSettleWake).toBeUndefined();
    }
    const lease = await leasePendingAgentSteeringItems({
      requesterSessionKey: input.subagent.requesterSessionKey,
      leaseId: "after-store-publication",
    });
    if (change === "same") {
      expect(lease?.prompt).toContain("canonical result");
    } else {
      expect(lease).toBeUndefined();
    }
  },
);
