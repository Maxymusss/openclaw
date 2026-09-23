import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { CommandProcessCleanupError } from "../../../process/exec-result.js";
import {
  retainCommandProcessCleanup,
  resolveCommandProcessSignal,
} from "../../../process/exec-spawn.js";
import { getProcessSupervisor } from "../../../process/supervisor/index.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { buildAgentRunTerminalOutcomeFromAttempt } from "../../agent-run-terminal-outcome.js";
import type { createOpenClawCodingToolsInternal } from "../../agent-tools.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import type { NativeSandboxCustody } from "../../sandbox/container-engine.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

async function waitForAttemptBoundary(boundary: Promise<void>, attempt: Promise<unknown>) {
  await Promise.race([
    boundary,
    attempt.then((result) => {
      throw new Error("Attempt completed before the expected setup or cleanup boundary.", {
        cause: result,
      });
    }),
  ]);
}

describe("runEmbeddedAttempt abort races", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
    vi.restoreAllMocks();
  });

  function foregroundAuthority() {
    return createAdmittedRunOperatorAuthority({
      profileId: "foreground-person",
      scopes: ["operator.sessions.write"],
      executionPolicy: "foreground-only",
      foregroundRunId: "run-context-engine-forwarding",
      foregroundDeadlineAt: Date.now() + 60_000,
      assertCurrent() {},
    });
  }

  it("joins late setup producers and every cleanup before preserving the original setup error", async () => {
    const producerEntered = createDeferred();
    const producerRelease = createDeferred();
    const cleanupEntered = createDeferred();
    const cleanupRelease = createDeferred();
    const setupFailure = new Error("sandbox setup failed");
    const cleanupFailure = new Error("native cleanup uncertain");
    const firstCleanup = vi.fn(() => {
      throw cleanupFailure;
    });
    const secondCleanup = vi.fn(async () => {
      cleanupEntered.resolve();
      await cleanupRelease.promise;
    });
    const supervisorCleanup = vi.fn(async () => {});
    const acquire = vi
      .spyOn(getProcessSupervisor(), "acquireScopeCleanup")
      .mockReturnValue(supervisorCleanup);
    hoisted.resolveSandboxContextMock.mockImplementation(async (_params, rawCustody) => {
      const custody = rawCustody as NativeSandboxCustody | undefined;
      if (!custody) {
        throw new Error("missing foreground custody");
      }
      expect(acquire).toHaveBeenCalledOnce();
      custody.registerCleanup(firstCleanup);
      custody.registerCleanup(secondCleanup);
      const producer = custody.runProducer(async () => {
        producerEntered.resolve();
        await producerRelease.promise;
      });
      void producer.catch(() => {});
      throw setupFailure;
    });
    const receipt = createAgentCleanupScope();
    const pending = receipt.run(() =>
      createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:foreground-setup-error",
        tempPaths,
        operatorAuthority: foregroundAuthority(),
      }),
    );
    const observed = pending.catch((error: unknown) => error);
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    try {
      await waitForAttemptBoundary(producerEntered.promise, pending);
      expect(hoisted.resolveSandboxContextMock).toHaveBeenCalledOnce();
      expect(firstCleanup).not.toHaveBeenCalled();
      expect(secondCleanup).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      producerRelease.resolve();
      await waitForAttemptBoundary(cleanupEntered.promise, pending);
      expect(firstCleanup).toHaveBeenCalledOnce();
      expect(supervisorCleanup).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      cleanupRelease.resolve();
      expect(await observed).toBe(setupFailure);
      expect(receipt.outcome).toBe("uncertain");
      expect(firstCleanup).toHaveBeenCalledOnce();
      expect(secondCleanup).toHaveBeenCalledOnce();
      expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
    } finally {
      producerRelease.resolve();
      cleanupRelease.resolve();
      await observed;
    }
  });

  it.each([false, true])(
    "retains settled command cleanup uncertainty without relabeling an ordinary producer error (uncertain=%s)",
    async (uncertain) => {
      const setupFailure = new Error("preparation rejected");
      const producerFailure = new Error("native probe failed before allocation");
      const cleanup = vi.fn(async () => {});
      vi.spyOn(getProcessSupervisor(), "acquireScopeCleanup").mockReturnValue(async () => {});
      hoisted.resolveSandboxContextMock.mockImplementation(async (_params, rawCustody) => {
        const custody = rawCustody as NativeSandboxCustody | undefined;
        if (!custody) {
          throw new Error("missing foreground custody");
        }
        custody.registerCleanup(cleanup);
        const producer = custody.runProducer(async () => {
          if (uncertain) {
            retainCommandProcessCleanup(Promise.resolve("uncertain"));
            return;
          }
          throw producerFailure;
        });
        if (uncertain) {
          await expect(producer).rejects.toBeInstanceOf(CommandProcessCleanupError);
        } else {
          await expect(producer).rejects.toBe(producerFailure);
        }
        throw setupFailure;
      });
      const receipt = createAgentCleanupScope();
      await expect(
        receipt.run(() =>
          createContextEngineAttemptRunner({
            contextEngine: createContextEngineBootstrapAndAssemble(),
            sessionKey: "agent:main:foreground-producer-error",
            tempPaths,
            operatorAuthority: foregroundAuthority(),
          }),
        ),
      ).rejects.toBe(setupFailure);
      expect(hoisted.resolveSandboxContextMock).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(receipt.outcome).toBe(uncertain ? "uncertain" : "closed");
      expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
    },
  );

  it("carries the original Stop signal into the separately owned setup command scope", async () => {
    const entered = createDeferred();
    const source = new AbortController();
    const cancellation = new Error("original turn stopped");
    const cleanup = vi.fn(async () => {});
    vi.spyOn(getProcessSupervisor(), "acquireScopeCleanup").mockReturnValue(async () => {});
    hoisted.resolveSandboxContextMock.mockImplementation(async (_params, rawCustody) => {
      const custody = rawCustody as NativeSandboxCustody | undefined;
      if (!custody) {
        throw new Error("missing foreground custody");
      }
      custody.registerCleanup(cleanup);
      return await custody.runProducer(async () => {
        const signal = resolveCommandProcessSignal();
        if (!signal) {
          throw new Error("missing native command cancellation");
        }
        entered.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        expect(signal.reason).toBe(cancellation);
        signal.throwIfAborted();
        return null;
      });
    });
    const pending = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:foreground-setup-stop",
      tempPaths,
      operatorAuthority: foregroundAuthority(),
      attemptOverrides: { abortSignal: source.signal },
    });
    const observed = pending.catch((error: unknown) => error);
    try {
      await waitForAttemptBoundary(entered.promise, pending);
      expect(hoisted.resolveSandboxContextMock).toHaveBeenCalledOnce();
      source.abort(cancellation);
      expect(await observed).toBe(cancellation);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
    } finally {
      source.abort(cancellation);
      await observed;
    }
  });

  it("adopts the setup generation for late tools and releases both resources exactly once", async () => {
    const setupEntered = createDeferred();
    const setupRelease = createDeferred();
    const nativeCleanup = vi.fn(async () => {});
    const toolCleanup = vi.fn(async () => {});
    const supervisorCleanup = vi.fn(async () => {});
    const acquire = vi
      .spyOn(getProcessSupervisor(), "acquireScopeCleanup")
      .mockReturnValue(supervisorCleanup);
    let runtimeKey: string | undefined;
    hoisted.resolveSandboxContextMock.mockImplementation(async (_params, rawCustody) => {
      const custody = rawCustody as NativeSandboxCustody | undefined;
      if (!custody) {
        throw new Error("missing foreground custody");
      }
      runtimeKey = custody.runtimeKey;
      custody.registerCleanup(nativeCleanup);
      setupEntered.resolve();
      await setupRelease.promise;
      return null;
    });
    const factory = hoisted.createOpenClawCodingToolsMock.mockImplementation((rawOptions) => {
      const options = rawOptions as Parameters<typeof createOpenClawCodingToolsInternal>[0];
      expect(options?.exec?.scopeKey).toBe(runtimeKey);
      expect(acquire).toHaveBeenCalledOnce();
      options?.registerRunCleanup?.(toolCleanup);
      return [];
    });
    const pending = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:foreground-late-tools",
      tempPaths,
      operatorAuthority: foregroundAuthority(),
      attemptOverrides: { disableTools: false },
    });
    try {
      await waitForAttemptBoundary(setupEntered.promise, pending);
      expect(hoisted.resolveSandboxContextMock).toHaveBeenCalledOnce();
      expect(factory).not.toHaveBeenCalled();
      expect(nativeCleanup).not.toHaveBeenCalled();
      setupRelease.resolve();
      expect((await pending).terminal).toEqual({ kind: "ok" });
      expect(factory).toHaveBeenCalledOnce();
      expect(nativeCleanup).toHaveBeenCalledOnce();
      expect(toolCleanup).toHaveBeenCalledOnce();
      expect(supervisorCleanup).toHaveBeenCalledOnce();
    } finally {
      setupRelease.resolve();
      await pending;
    }
  });

  it.each([false, true])(
    "bounds registered one-shot cleanup after a completed turn (fails=%s)",
    async (fails) => {
      const held = createDeferred();
      const started = createDeferred();
      const cleanupScope = createAgentCleanupScope();
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
        (
          options as { registerRunCleanup: (cleanup: () => Promise<void>) => void }
        ).registerRunCleanup(async () => {
          started.resolve();
          await held.promise;
          if (fails) {
            throw new Error("registered resource teardown failed");
          }
        });
        return [];
      });
      const attempt = cleanupScope.run(() =>
        createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: "agent:main:triage:cleanup",
          tempPaths,
          sessionPrompt: async () => {
            vi.useFakeTimers();
          },
          attemptOverrides: { oneShotCliRun: true, disableTools: false },
        }),
      );
      try {
        await started.promise;
        if (fails) {
          held.resolve();
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(cleanupScope.outcome).toBe("uncertain");
        expect((await attempt).terminal).toEqual({ kind: "ok" });
      } finally {
        held.resolve();
        await attempt;
        vi.useRealTimers();
      }
    },
  );

  it("preserves a run-budget timeout when abort blocks prompt submission", async () => {
    let releasePendingEvents!: () => void;
    const pendingEvents = new Promise<void>((resolve) => {
      releasePendingEvents = resolve;
    });
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
      ...baseSubscribe(params),
      waitForPendingEvents: async () => await pendingEvents,
    }));

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:timeout",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        timeoutMs: 20,
        onAttemptTimeout: () => releasePendingEvents(),
      },
    });

    // The abort-blocked prompt release no longer unwinds the attempt: the run
    // settles so after-turn side effects still fire, and the run-budget
    // timeout attribution survives on the resolved terminal.
    const result = await attempt;

    expect(result.terminal).toMatchObject({ kind: "timeout" });
    expect(buildAgentRunTerminalOutcomeFromAttempt({ terminal: result.terminal })).toMatchObject({
      status: "timeout",
    });
  });
});
