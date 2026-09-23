import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(async (_options: AgentCommandOpts) => ({ payloads: [], meta: {} })),
  clearAgentRunContext: vi.fn(),
}));
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: mocks.agentCommand }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));
vi.mock(import("../../infra/agent-run-registry.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  clearAgentRunContext: mocks.clearAgentRunContext,
  validateAgentRunDelegatedAuthority: () => true,
}));
vi.mock("./agent-dedupe.js", () => ({ setGatewayDedupeEntries: vi.fn() }));

describe("Gateway dispatch run ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentCommand.mockImplementation(async () => ({ payloads: [], meta: {} }));
  });
  it("keeps rejected pre-dispatch results with their admitted registration", async () => {
    const { runId, sessionKey, context, entry } = createTrackedDispatch();
    const successor: ChatAbortControllerEntry = {
      ...entry,
      controller: new AbortController(),
      sessionId: "successor-session",
      sessionKey: "agent:main:successor-session",
      operationalRunInstance: { runId, instanceId: "successor-instance" },
    };
    context.chatAbortControllers.set(runId, successor);
    const emitFinal = vi.fn();
    await dispatchAgentRunFromGateway({
      assertCurrent() {
        if (context.chatAbortControllers.get(runId) !== entry) {
          throw new Error("Gateway run owner replaced");
        }
      },
      admittedRunEntry: entry,
      ingressOpts: {
        message: "run only for the admitted owner",
        sessionKey,
        allowModelOverride: false,
      },
      runId,
      dedupeKeys: [`agent:${runId}`],
      abortController: entry.controller,
      cleanupAbortController: vi.fn(),
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.get(runId)).toBe(successor);
    expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          sessionKey,
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          lifecycleGeneration: entry.lifecycleGeneration,
        },
        entry: expect.objectContaining({ ok: false }),
      }),
    );
    expect(emitFinal).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure", "cancelled"] as const)(
    "awaits continuation settlement before releasing the run and reporting %s",
    async (outcome) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const entered = createDeferred();
      const resume = createDeferred();
      mocks.agentCommand.mockImplementationOnce(async () => {
        if (outcome === "failure") {
          throw new Error("Synthetic active run failure");
        }
        if (outcome === "cancelled") {
          entry.controller.abort();
          throw entry.controller.signal.reason;
        }
        return { payloads: [], meta: {} };
      });
      const emitFinal = vi.fn();
      const cleanupAbortController = vi.fn();
      const onSettled = vi.fn(async () => {
        entered.resolve();
        await resume.promise;
        return true;
      });
      const completion = dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
        onSettled,
      });
      try {
        await entered.promise;
        expect(emitFinal).not.toHaveBeenCalled();
        expect(cleanupAbortController).not.toHaveBeenCalled();
        resume.resolve();
        await completion;
        expect(cleanupAbortController).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledOnce();
        expect(emitFinal).toHaveBeenCalledWith(
          [
            outcome !== "failure",
            expect.objectContaining({
              status: outcome === "success" ? "ok" : outcome === "failure" ? "error" : "timeout",
            }),
            outcome === "failure" ? expect.any(Object) : undefined,
          ],
          expect.objectContaining({ runId }),
        );
        expect(cleanupAbortController.mock.invocationCallOrder[0]).toBeLessThan(
          emitFinal.mock.invocationCallOrder[0] ?? Infinity,
        );
      } finally {
        resume.resolve();
        await completion;
      }
    },
  );

  it.each(["same-session", "different-session"] as const)(
    "does not release a %s successor when the accepted run completes",
    async (replacement) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const successor = {
        ...entry,
        controller: new AbortController(),
        operationalRunInstance: { runId, instanceId: "successor" },
        sessionKey: replacement === "same-session" ? sessionKey : "agent:main:other",
      };
      mocks.agentCommand.mockImplementationOnce(async () => {
        context.chatAbortControllers.set(runId, successor);
        return { payloads: [], meta: {} };
      });
      await dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
        context,
      });
      expect(mocks.clearAgentRunContext).not.toHaveBeenCalled();
      expect(context.chatAbortControllers.get(runId)).toBe(successor);
      expect(setGatewayDedupeEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          session: {
            sessionKey,
            sessionId: entry.sessionId,
            agentId: entry.agentId,
            lifecycleGeneration: entry.lifecycleGeneration,
          },
        }),
      );
    },
  );

  it.each(["Primitive command failure", 42])(
    "retains the rendered message and original cause for synchronous throw %s",
    async (failure) => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      mocks.agentCommand.mockImplementationOnce(() => {
        // oxlint-disable-next-line typescript/only-throw-error -- Exercise JavaScript primitive throws at the dispatch boundary.
        throw failure;
      });
      const emitFinal = vi.fn();
      await dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: { message: "continue", sessionKey, allowModelOverride: false },
        runId,
        dedupeKeys: [],
        abortController: entry.controller,
        cleanupAbortController: vi.fn(),
        io: { emitAcceptance: vi.fn(), emitFinal },
        context,
      });
      expect(emitFinal).toHaveBeenCalledWith(
        [
          false,
          expect.objectContaining({ status: "error", summary: String(failure) }),
          expect.objectContaining({
            message: String(failure),
            cause: expect.objectContaining({ cause: failure }),
          }),
        ],
        expect.objectContaining({ error: String(failure) }),
      );
    },
  );
});
