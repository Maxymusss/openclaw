import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import * as admission from "./subagent-completion-admission.store.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "./subagent-completion-delivery.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("subagent completion recovery identity", () => {
  let database: OpenClawStateDatabase;

  beforeEach(() => {
    const tempDir = tempDirs.make(
      "openclaw-completion-recovery-",
      resolvePreferredOpenClawTmpDir(),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
    resumeSubagentRun.mockClear();
  });

  afterEach(() => {
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function persistCompletion(
    name: "old" | "current",
    deliveryStatus: "suspended" | "delivered" = "suspended",
    remappedRun = false,
  ) {
    const now = Date.now();
    const subagent = createSubagentRunRecord({
      runId: remappedRun ? `completion-${name}` : `run-${name}`,
      taskRunId: remappedRun ? `run-${name}` : undefined,
      childSessionKey: "agent:main:subagent:shared",
      task: `finish ${name} work`,
      createdAt: now - (name === "old" ? 20_000 : 10_000),
      endedAt: now - 1_000,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      completion: { required: true, resultText: `${name} result`, capturedAt: now },
      delivery: {
        status: deliveryStatus,
        disposition: deliveryStatus === "suspended" ? "permanent_failure" : "delivered",
        generation: 1,
        ...(deliveryStatus === "suspended"
          ? { suspendedAt: now, suspendedReason: "expiry", lastError: "requester unavailable" }
          : { deliveredAt: now }),
      },
    });
    settleSubagentCompletionDelivery({ subagent, databaseOptions: { database } });
    subagentRuns.set(subagent.runId, subagent);
    return { subagent };
  }

  function storedPair(pair: ReturnType<typeof persistCompletion>) {
    const row = database.db
      .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
      .get(pair.subagent.runId) as { payload_json: string } | undefined;
    return {
      subagent: row ? (JSON.parse(row.payload_json) as unknown) : undefined,
    };
  }

  function dismiss(taskId: string) {
    return dismissSubagentCompletionDelivery(taskId, {
      discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
      databaseOptions: { database },
    });
  }

  it.each([false, true])(
    "dismisses only the selected result (remapped run: %s)",
    async (remapped) => {
      // Retained completions precede follow-up runs on the same reusable child session.
      const old = persistCompletion("old");
      const current = persistCompletion("current", "suspended", remapped);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect.soft(dismiss(current.subagent.runId)).resolves.toMatchObject({
        ok: true,
        run: { delivery: { status: "discarded" }, completion: { resultText: "current result" } },
      });
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "discarded",
          disposition: "intentional_non_delivery",
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );

  it.each(["delivered", "suspended"] as const)(
    "retries the selected completion with an older %s run on its session",
    async (oldStatus) => {
      const old = persistCompletion("old", oldStatus);
      const current = persistCompletion("current", "suspended", true);
      const oldRows = storedPair(old);
      const oldLive = structuredClone(old.subagent);

      await expect
        .soft(retrySubagentCompletionDelivery(current.subagent.runId, { database }))
        .resolves.toMatchObject({
          ok: true,
          duplicateRisk: true,
          run: { delivery: { status: "pending" }, completion: { resultText: "current result" } },
        });
      expect.soft(resumeSubagentRun.mock.calls).toEqual([[current.subagent.runId]]);
      expect.soft(storedPair(current).subagent).toMatchObject({
        delivery: {
          status: "pending",
          generation: 2,
        },
      });
      expect.soft(storedPair(old)).toEqual(oldRows);
      expect.soft(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
    },
  );

  it.each([false, true])(
    "retries under a fresh operator without reviving retired custody (write fails: %s)",
    async (fails) => {
      const { subagent } = persistCompletion("current");
      const context = createContext();
      const originalClient = createOperatorClient({
        profileId: "original",
        scopes: ["operator.write"],
      });
      const original = withPluginRuntimeGatewayRequestScope(
        { client: originalClient, context, isWebchatConnect: () => false },
        captureOperatorToolGatewayContinuationContext,
      )!;
      subagentRuns.bindCompletionAuthority(subagent, original);
      subagentRuns.releaseCompletionAuthority(subagent);
      expect(() => subagentRuns.runWithCompletionAuthority(subagent, () => "retired")).toThrow(
        /authority/,
      );
      const client = createOperatorClient({ profileId: "retry-owner", scopes: ["operator.write"] });
      const fresh = captureGatewayOperatorRunAuthority({ client, context })!;
      client.internal = { operatorRunAuthority: fresh.authority };
      if (fails) {
        vi.spyOn(admission, "settleSubagentCompletionDelivery").mockImplementationOnce(() => {
          throw new Error("write refused");
        });
      }
      try {
        const retry = withPluginRuntimeGatewayRequestScope(
          { client, context, isWebchatConnect: () => false },
          () => retrySubagentCompletionDelivery(subagent.runId, { database }),
        );
        if (fails) {
          await expect(retry).rejects.toThrow("write refused");
        } else {
          await expect(retry).resolves.toMatchObject({ ok: true });
        }
        fresh.release();
        if (fails) {
          expect(fresh.authority.assertCurrent).toThrow();
        } else {
          subagentRuns.runWithCompletionAuthority(subagent, () =>
            expect(
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source,
            ).toBe(fresh.authority.source),
          );
          subagentRuns.releaseCompletionAuthority(subagent);
          expect(fresh.authority.assertCurrent).toThrow();
        }
        expect(original.operatorAuthority?.assertCurrent).toThrow();
      } finally {
        fresh.release();
      }
    },
  );

  it.each(["dismiss", "retry"] as const)(
    "%s fails closed when only a sibling completion owner remains",
    async (action) => {
      const old = persistCompletion("old");
      const current = persistCompletion("current");
      subagentRuns.delete(current.subagent.runId);
      database.db.prepare("DELETE FROM subagent_runs WHERE run_id = ?").run(current.subagent.runId);
      const oldRows = storedPair(old);
      const currentRows = storedPair(current);
      const oldLive = structuredClone(old.subagent);

      const result = await (action === "dismiss"
        ? dismiss(current.subagent.runId)
        : retrySubagentCompletionDelivery(current.subagent.runId, { database }));

      expect(result).toEqual({
        ok: false,
        reason:
          action === "dismiss"
            ? "completion delivery is not blocked"
            : "task has no recoverable subagent completion",
      });
      expect(storedPair(old)).toEqual(oldRows);
      expect(storedPair(current)).toEqual(currentRows);
      expect(subagentRuns.get(old.subagent.runId)).toEqual(oldLive);
      expect(resumeSubagentRun).not.toHaveBeenCalled();
    },
  );
});
