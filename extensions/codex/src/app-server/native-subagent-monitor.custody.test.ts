import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  childTurnCompletedNotification,
  directSpawnItem,
  nativeCompletionNotification,
  registerParent,
  successfulSendInputOutput,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";

function createCustody() {
  const holds: AgentHarnessCompletionCustody[] = [];
  const executions = new Set<AgentHarnessCompletionCustody>();
  const released = createDeferred<void>();
  const retain = (settled = false): AgentHarnessCompletionCustody => {
    const lifetime = new AbortController();
    const hold: AgentHarnessCompletionCustody = {
      signal: lifetime.signal,
      isCurrent: () => !lifetime.signal.aborted,
      retain() {
        lifetime.signal.throwIfAborted();
        return retain(!executions.has(hold));
      },
      settleExecution: () => {
        executions.delete(hold);
      },
      release() {
        executions.delete(hold);
        lifetime.abort();
        if (holds.every((entry) => entry.signal.aborted)) {
          released.resolve();
        }
      },
    };
    holds.push(hold);
    if (!settled) {
      executions.add(hold);
    }
    return hold;
  };
  return {
    root: retain(),
    holds,
    executions,
    released: released.promise,
    live: () => holds.filter((hold) => !hold.signal.aborted),
  };
}

afterEach(() => vi.useRealTimers());

describe("native assignment completion custody", () => {
  it.each(["delivered", "retry", "closed", "exhausted"] as const)(
    "retains the exact overlapping owner through parent yield and releases on %s",
    async (ending) => {
      vi.useFakeTimers();
      const client = createClient();
      const runtime = createRuntime();
      const first = createCustody();
      const second = createCustody();
      runtime.captureAgentHarnessCompletionCustody
        .mockReturnValueOnce(first.root)
        .mockReturnValueOnce(second.root);
      if (ending !== "delivered") {
        runtime.deliverAgentHarnessCompletion.mockResolvedValue({
          delivered: false,
          path: "none",
        });
      }
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        completionDeliveryRetryDelaysMs: [1],
        completionDeliveryMaxRetries: 1,
      });
      const owner = registerParent(monitor);
      const other = registerParent(monitor);
      other.bindTurn("other-turn");
      // Native spawn evidence can arrive before the admitting turn/start response.
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem("v2", "parent-thread", "child-thread"),
        },
      });
      owner.bindTurn("parent-turn");
      await owner.unregister();
      expect(first.live()).toHaveLength(1);
      await other.unregister();
      expect(second.live()).toHaveLength(0);
      await client.notify(nativeCompletionNotification({ agentPath: "/root/child-thread" }));
      expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
      expect(first.holds).toContain(
        runtime.deliverAgentHarnessCompletion.mock.calls[0]![0].completionCustody,
      );
      expect(first.executions.size).toBe(0);
      if (ending === "closed") {
        monitor.dispose();
        expect(first.live()).toHaveLength(1);
        runtime.deliverAgentHarnessCompletion.mockResolvedValue({
          delivered: true,
          path: "direct",
        });
        await vi.advanceTimersByTimeAsync(1);
      } else if (ending === "retry") {
        runtime.deliverAgentHarnessCompletion.mockResolvedValue({
          delivered: true,
          path: "direct",
        });
        await vi.advanceTimersByTimeAsync(1);
      } else if (ending === "exhausted") {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(first.live()).toHaveLength(0);
      monitor.dispose();
    },
  );

  it("releases interrupted execution and disposes all children after stale event custody", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const source = createCustody();
    runtime.captureAgentHarnessCompletionCustody.mockReturnValue(source.root);
    const emit = vi.fn();
    runtime.createAgentHarnessCompletionEventSink.mockReturnValue(emit);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    const parent = registerParent(monitor);
    parent.bindTurn("parent-turn");
    for (const child of ["child-thread", "other-child"]) {
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem("v2", "parent-thread", child),
        },
      });
      await client.notify(turnStartedNotification("child-turn", { threadId: child }));
    }
    await parent.unregister();
    expect(source.live()).toHaveLength(2);
    await client.notify(childTurnCompletedNotification({ status: "interrupted" }));
    expect(source.live()).toHaveLength(1);
    expect(source.executions.size).toBe(1);
    emit.mockImplementation(() => {
      throw new Error("requester lifecycle replaced");
    });
    expect(() => monitor.dispose()).not.toThrow();
    expect(source.live()).toHaveLength(0);
    expect(source.executions.size).toBe(0);
  });

  it("releases an accepted submission whose predecessor never acquired a turn anchor", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const source = createCustody();
    runtime.captureAgentHarnessCompletionCustody.mockReturnValue(source.root);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
      hasObservationBacking: () => true,
    });
    const parent = registerParent(monitor);
    parent.bindTurn("parent-turn");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: directSpawnItem("v2", "parent-thread", "child-thread"),
      },
    });
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          id: "send-child",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
        },
      },
    });
    await client.notify(
      successfulSendInputOutput({ callId: "send-child", submissionId: "followup-turn" }),
    );
    await parent.unregister();
    expect(source.live()).toHaveLength(2);
    monitor.dispose();
    expect(source.live()).toHaveLength(0);
  });
});
