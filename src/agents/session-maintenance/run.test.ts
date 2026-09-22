import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { buildEmbeddedRunBaseParams } from "../../auto-reply/reply/agent-runner-run-params.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import * as gatewayWork from "../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as maintenanceBudget from "../command/maintenance-budget.js";
import * as runtimeLoaders from "../command/runtime-loaders.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import * as maintenanceCoordinator from "./coordinator.js";
import { createSessionMaintenanceFollowup, scheduleSessionMaintenance } from "./run.js";

it.each(["foreground", "expired", "revoked"] as const)(
  "skips optional maintenance before acquiring work for a %s source",
  async (state) => {
    const followupRun = createTestFollowupRun();
    const source = new AbortController();
    const retain = vi.fn(() => () => {});
    followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "restricted-maintenance",
      scopes: ["operator.write"],
      permissions: { models: { allow: ["test-provider/test-model"] } },
      executionPolicy: "foreground-only",
      foregroundRunId: "original-turn",
      foregroundDeadlineAt: Date.now() + (state === "expired" ? -1 : 60_000),
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
      retain,
    });
    if (state === "revoked") {
      source.abort(new Error("original source revoked"));
    }
    const budget = vi.spyOn(maintenanceBudget, "createCommandBudget");
    const owner = vi.spyOn(maintenanceCoordinator, "createSessionMaintenanceOwner");
    const root = vi.spyOn(gatewayWork, "runWithGatewayIndependentRootWorkAdmission");
    const store = vi.spyOn(runtimeLoaders, "loadSessionStoreRuntime");
    const memory = vi.spyOn(runtimeLoaders, "loadAgentRunnerMemoryRuntime");
    const sessionKey = "agent:main:restricted-maintenance";
    try {
      expect(() =>
        withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
          scheduleSessionMaintenance({
            prepared: {
              cfg: followupRun.run.config,
              sessionKey,
              storePath: "/synthetic/maintenance.sqlite",
              timeoutMs: 1_000,
            },
            followupRun,
            sessionId: followupRun.run.sessionId,
            lifecycleRevision: undefined,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            startedAt: Date.now(),
          }),
        ),
      ).not.toThrow();
      expect(budget).not.toHaveBeenCalled();
      expect(owner).not.toHaveBeenCalled();
      expect(root).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(memory).not.toHaveBeenCalled();
    } finally {
      await waitForSessionMaintenance(sessionKey);
      memory.mockRestore();
      store.mockRestore();
      root.mockRestore();
      owner.mockRestore();
      budget.mockRestore();
    }
  },
);

it("preserves original model authority without foreground tool or writer custody", async () => {
  const original = createAdmittedRunOperatorAuthority({
    profileId: "viewer",
    scopes: ["operator.sessions.write"],
    permissions: { models: { allow: ["test-provider/test-model"] } },
    assertCurrent: () => {},
  });
  const foreground = createTestFollowupRun({
    provider: "test-provider",
    model: "test-model",
    thinkingCatalog: [{ provider: "test-provider", id: "test-model", input: ["text", "image"] }],
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
  const maintenance = createSessionMaintenanceFollowup({
    operatorAuthority: original,
    run: foreground.run,
    sessionEntry: { sessionId: "maintenance", updatedAt: 1 },
    sessionKey: "agent:main:maintenance",
    cfg: foreground.run.config,
    provider: "test-provider",
    model: "test-model",
    auth: {},
  });
  const embedded = await buildEmbeddedRunBaseParams({
    run: maintenance.run,
    provider: "test-provider",
    model: "test-model",
    runId: "maintenance-run",
    authProfile: {},
    isReasoningTagProvider: () => {
      throw new Error("Prepared runtime hints must not be rediscovered");
    },
  });
  expect(embedded.modelHasVision).toBe(true);
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.senderIsOwner).toBe(false);
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
  expect(maintenance.operatorAuthority).toBe(original);
  expect(maintenance.operatorAuthority?.permissions?.models?.allow).toEqual([
    "test-provider/test-model",
  ]);
});

it.each(["success", "failure", "deadline"] as const)(
  "retains maintenance authority and budget through provider and cleanup tails after %s",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const sessionKey = `agent:main:maintenance-${outcome}`;
    const followupRun = createTestFollowupRun({
      provider: "test-provider",
      model: "test-model",
      sessionKey,
    });
    const entry: SessionEntry = {
      sessionId: followupRun.run.sessionId,
      updatedAt: Date.now(),
      lifecycleRevision: `maintenance-${outcome}`,
    };
    const events: string[] = [];
    const releaseSource = vi.fn(() => {
      events.push("source released");
    });
    const retainSource = vi.fn(() => releaseSource);
    followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "viewer",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow: ["test-provider/test-model"] } },
      assertCurrent: () => {},
      retain: retainSource,
    });
    const flushEntered = createDeferredCore<{
      admissionSignal: AbortSignal;
      workSignal: AbortSignal;
    }>();
    const finishFlush = createDeferredCore();
    const finishProvider = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const disposed = createDeferredCore();
    const cleanupError = new Error("maintenance cleanup failed");
    const tails: Promise<void>[] = [];
    const disposeBudget = vi.fn(() => {
      events.push("budget disposed");
      disposed.resolve();
    });
    const createBudget = maintenanceBudget.createCommandBudget;
    const budgetSpy = vi
      .spyOn(maintenanceBudget, "createCommandBudget")
      .mockImplementation((...args) => {
        const budget = createBudget(...args);
        return {
          ...budget,
          dispose: () => {
            budget.dispose();
            disposeBudget();
          },
        };
      });
    type StoreRuntime = Awaited<ReturnType<typeof runtimeLoaders.loadSessionStoreRuntime>>;
    const storeSpy = vi.spyOn(runtimeLoaders, "loadSessionStoreRuntime").mockResolvedValue({
      updateSessionStoreAfterAgentRun: vi.fn<StoreRuntime["updateSessionStoreAfterAgentRun"]>(),
      loadSessionEntry: vi.fn<StoreRuntime["loadSessionEntry"]>(),
      loadSessionEntryReadOnly: vi.fn<StoreRuntime["loadSessionEntryReadOnly"]>(() => entry),
    });
    type MemoryRuntime = Awaited<ReturnType<typeof runtimeLoaders.loadAgentRunnerMemoryRuntime>>;
    const compact = vi.fn<MemoryRuntime["runSessionCompactionIfNeeded"]>().mockResolvedValue(entry);
    const flush = vi.fn<MemoryRuntime["runMemoryFlushIfNeeded"]>(async (params) => {
      const workSignal = expectDefined(getAsyncWorkSignal(), "maintenance work scope signal");
      workSignal.addEventListener("abort", () => events.push("scope closed"), { once: true });
      const providerTail = trackAsyncWork(async () => {
        try {
          await finishProvider.promise;
        } finally {
          // This accepted provider continuation registers its own cleanup in the same scope.
          const cleanupTail = trackAsyncWork(async () => {
            cleanupEntered.resolve();
            try {
              await finishCleanup.promise;
            } finally {
              events.push("cleanup settled");
            }
          });
          tails.push(cleanupTail);
          void cleanupTail.catch(() => {});
        }
      });
      tails.push(providerTail);
      flushEntered.resolve({
        admissionSignal: expectDefined(params.abortSignal, "maintenance admission signal"),
        workSignal,
      });
      await finishFlush.promise;
      if (outcome === "failure") {
        throw new Error("maintenance flush failed");
      }
      return { sessionEntry: entry, outcome: "skipped" };
    });
    const memorySpy = vi.spyOn(runtimeLoaders, "loadAgentRunnerMemoryRuntime").mockResolvedValue({
      runMemoryFlushIfNeeded: flush,
      runSessionCompactionIfNeeded: compact,
    });
    try {
      withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
        scheduleSessionMaintenance({
          prepared: {
            cfg: followupRun.run.config,
            sessionKey,
            storePath: path.join(
              expectDefined(followupRun.run.agentDir, "maintenance agent directory"),
              "sessions.sqlite",
            ),
            timeoutMs: 1_000,
          },
          followupRun,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          startedAt: Date.now(),
        });
      });
      expect(budgetSpy).toHaveBeenCalledTimes(1);
      const signals = expectDefined(
        await Promise.race([flushEntered.promise, disposed.promise.then(() => undefined)]),
        "maintenance flush-entry signals",
      );
      if (outcome === "deadline") {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      finishFlush.resolve();
      await waitForSessionMaintenance(sessionKey);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(compact).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(signals.admissionSignal.aborted).toBe(outcome === "deadline");
      expect(retainSource).toHaveBeenCalledTimes(1);
      expect(releaseSource).not.toHaveBeenCalled();
      expect(disposeBudget).not.toHaveBeenCalled();

      finishProvider.resolve();
      expect(
        await Promise.race([
          cleanupEntered.promise.then(() => "cleanup"),
          disposed.promise.then(() => "disposed"),
        ]),
      ).toBe("cleanup");
      // Deadline closes admission, but accepted tails still belong to the retained work scope.
      expect(signals.workSignal.aborted).toBe(false);
      expect(releaseSource).not.toHaveBeenCalled();
      expect(disposeBudget).not.toHaveBeenCalled();
      if (outcome === "failure") {
        finishCleanup.reject(cleanupError);
      } else {
        finishCleanup.resolve();
      }
      await disposed.promise;
      expect(await Promise.allSettled(tails)).toEqual([
        { status: "fulfilled", value: undefined },
        outcome === "failure"
          ? { status: "rejected", reason: cleanupError }
          : { status: "fulfilled", value: undefined },
      ]);
      expect(releaseSource).toHaveBeenCalledTimes(1);
      expect(disposeBudget).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        "cleanup settled",
        "scope closed",
        "source released",
        "budget disposed",
      ]);
    } finally {
      finishFlush.resolve();
      finishProvider.resolve();
      finishCleanup.resolve();
      await waitForSessionMaintenance(sessionKey);
      await Promise.allSettled(tails);
      if (budgetSpy.mock.calls.length > 0) {
        await disposed.promise;
      }
      memorySpy.mockRestore();
      storeSpy.mockRestore();
      budgetSpy.mockRestore();
      vi.useRealTimers();
    }
  },
);
