import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import {
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";

export function registerRequesterTranscriptOwnershipTest({
  getRegistry,
  mocks,
  recoveryRuntime,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "callGateway" | "runSubagentAnnounceFlow"
  >;
  recoveryRuntime: GatewayRecoveryRuntime;
}): void {
  it("detaches subagent completion from a disposed requester transcript owner", async () => {
    const mod = getRegistry();
    const sessionKey = "agent:main:main";
    const activeGatewayContext = { recoveryRuntime } as never;
    mod.activateSubagentRegistry(
      () => ({ recoveryRuntime, resolveGatewayContext: () => activeGatewayContext }) as never,
    );
    let disposed = false;
    let resolveWait: (value: Record<string, unknown>) => void = () => {};
    const pendingWait = new Promise<Record<string, unknown>>((resolve) => {
      resolveWait = resolve;
    });
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const freshCompletionWrite = vi.fn(async () => {});
    const announceEntered = createDeferred();

    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      const result = await pendingWait;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshCompletionWrite);
      return result;
    });
    mocks.runSubagentAnnounceFlow.mockImplementation(async () => {
      announceEntered.resolve();
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return "delivered";
    });

    const settleRootWork = observeRootWork();
    try {
      await withOwnedSessionTranscriptWrites(
        { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
        async () => {
          mod.registerSubagentRun({
            runId: "run-detached-requester-owner",
            requesterSessionKey: sessionKey,
            task: "finish after the requester attempt exits",
            expectsCompletionMessage: true,
          });
          await waitForFast(() =>
            expect(mocks.callGateway).toHaveBeenCalledWith(
              expect.objectContaining({ method: "agent.wait" }),
            ),
          );
        },
      );
      disposed = true;
      resolveWait({ status: "ok", startedAt: 111, endedAt: 222 });
      await announceEntered.promise;
    } finally {
      disposed = true;
      resolveWait({ status: "ok", startedAt: 111, endedAt: 222 });
      await settleRootWork();
    }

    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(freshCompletionWrite).toHaveBeenCalledOnce();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const announceParams = (
      mocks.runSubagentAnnounceFlow.mock.calls as unknown as Array<
        [{ resolveGatewayContext?: () => unknown }]
      >
    )[0]?.[0];
    expect(announceParams?.resolveGatewayContext?.()).toBe(activeGatewayContext);
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
  });
}
