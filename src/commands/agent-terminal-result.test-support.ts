import path from "node:path";
import { expect, it, vi } from "vitest";
import type * as attemptExecutionRuntimeModule from "../agents/command/attempt-execution.runtime.js";
import type { deliverAgentCommandResult as DeliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import type { runEmbeddedAgent as RunEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
import type { RuntimeEnv } from "../runtime.js";
import type { createDefaultAgentResult as CreateDefaultAgentResult } from "./agent-session.test-support.js";
import type { agentCommand as AgentCommand } from "./agent.js";

export function registerAgentTerminalResultTests({
  withTempHome,
  mockConfig,
  runtime,
  agentCommand,
  runEmbeddedAgent,
  deliverAgentCommandResult,
  attemptExecutionRuntime,
  createDefaultAgentResult,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (home: string, storePath: string) => unknown;
  runtime: RuntimeEnv;
  agentCommand: typeof AgentCommand;
  runEmbeddedAgent: typeof RunEmbeddedAgent;
  deliverAgentCommandResult: typeof DeliverAgentCommandResult;
  attemptExecutionRuntime: typeof attemptExecutionRuntimeModule;
  createDefaultAgentResult: typeof CreateDefaultAgentResult;
}) {
  it.each([
    {
      name: "completed stop",
      meta: { stopReason: "stop", finalAssistantVisibleText: "ok", finalAssistantRawText: "ok" },
      outcome: "completed",
    },
    {
      name: "structured blocked result",
      meta: {
        replayInvalid: true,
        livenessState: "blocked" as const,
        finalAssistantVisibleText: "Prompt exceeds model context",
        finalAssistantRawText: "Prompt exceeds model context",
        error: { kind: "context_overflow" as const, message: "Prompt exceeds model context" },
      },
      outcome: "failed",
    },
    { name: "cancelled result", meta: { aborted: true, stopReason: "stop" }, outcome: "failed" },
    {
      name: "provider timeout",
      meta: { aborted: true, stopReason: "timeout", timeoutPhase: "provider" as const },
      outcome: "failed",
    },
    { name: "yielded turn", meta: { yielded: true }, outcome: "completed" },
    {
      name: "exhausted fallback",
      meta: {
        error: {
          kind: "incomplete_turn" as const,
          message: "Incomplete terminal response",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
      outcome: "failed",
    },
    { name: "callback error", meta: {}, fault: "callback", outcome: "failed" },
    { name: "late cancellation", meta: {}, fault: "abort", outcome: "failed" },
  ])(
    "hands off the terminal outcome after real delivery projection: $name",
    async ({ meta, outcome, fault }) => {
      await withTempHome(async (home) => {
        mockConfig(home, path.join(home, "sessions.json"));
        const controller = new AbortController();
        const secret = ["sk", "abcdefghijklmnopqrstuv"].join("-");
        const text = meta.error?.message ?? "ok";
        const rawResult = {
          ...createDefaultAgentResult(),
          payloads: [{ text, ...(meta.error ? { isError: true } : {}) }],
          meta: { ...createDefaultAgentResult().meta, ...meta },
        };
        vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
          if (fault === "callback") {
            await params.onAgentEvent?.({
              stream: "lifecycle",
              data: {
                phase: "finishing",
                error: `Deferred provider failure. Authorization: Bearer ${secret}`,
              },
            });
          }
          return rawResult;
        });
        const actualDelivery = await vi.importActual<
          typeof import("../agents/command/delivery.js")
        >("../agents/command/delivery.js");
        vi.mocked(deliverAgentCommandResult).mockImplementationOnce(async (params) => {
          const projected = await actualDelivery.deliverAgentCommandResult(params);
          if (fault === "abort") {
            controller.abort();
          }
          return projected;
        });

        const result = await agentCommand(
          { message: "probe", agentId: "main", json: true, abortSignal: controller.signal },
          runtime,
        );

        expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
        expect(result?.payloads).toEqual([
          { text, mediaUrl: null, ...(meta.error ? { isError: true } : {}) },
        ]);
        expect(vi.mocked(runtime.log).mock.calls.at(-1)?.[0]).toBe(JSON.stringify(result, null, 2));
        if (outcome === "completed" && !meta.yielded) {
          expect(result?.meta.terminalReply).toEqual({ disposition: "visible", text });
        }
        expect(readAgentRunTerminalOutcome(rawResult)).toBeUndefined();
        expect(readAgentRunTerminalError(rawResult)).toBeUndefined();
        expect(readAgentRunTerminalOutcome(result)).toBe(outcome);
        if (fault === "callback") {
          expect(readAgentRunTerminalError(result)).toContain("Deferred provider failure.");
          expect(readAgentRunTerminalError(result)).not.toContain(secret);
        } else if (outcome === "completed") {
          expect(readAgentRunTerminalError(result)).toBeUndefined();
        }
      });
    },
  );

  it("keeps best-effort delivery failure separate from the completed run outcome", async () => {
    await withTempHome(async (home) => {
      mockConfig(home, path.join(home, "sessions.json"));
      const actualDelivery = await vi.importActual<typeof import("../agents/command/delivery.js")>(
        "../agents/command/delivery.js",
      );
      vi.mocked(deliverAgentCommandResult).mockImplementationOnce(
        actualDelivery.deliverAgentCommandResult,
      );

      const result = await agentCommand(
        {
          message: "probe",
          agentId: "main",
          json: true,
          deliver: true,
          channel: "webchat",
          bestEffortDeliver: true,
        },
        runtime,
      );

      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(result?.deliveryStatus).toMatchObject({ status: "failed", succeeded: false });
      expect(readAgentRunTerminalOutcome(result)).toBe("completed");
    });
  });

  it.each(["rejection", "cancellation"] as const)(
    "settles deferred cleanup %s before handing off the reply",
    async (fault) => {
      await withTempHome(async (home) => {
        mockConfig(home, path.join(home, "sessions.json"));
        const controller = new AbortController();
        const failure = new Error("Deferred cleanup failed");
        vi.mocked(attemptExecutionRuntime.runAgentAttempt).mockImplementationOnce(
          async (params) => {
            params.deferredLifecycle?.adopt({
              beginRetryWait: () => undefined,
              complete: async () => {
                if (fault === "rejection") {
                  throw failure;
                }
                controller.abort();
              },
              discard: () => {},
            });
            return createDefaultAgentResult();
          },
        );

        const command = agentCommand(
          { message: "probe", agentId: "main", abortSignal: controller.signal },
          runtime,
        );
        if (fault === "rejection") {
          await expect(command).rejects.toBe(failure);
        } else {
          expect(readAgentRunTerminalOutcome(await command)).toBe("failed");
        }
        expect(runtime.log).toHaveBeenCalledWith("ok");
      });
    },
  );
}
