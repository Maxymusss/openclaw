import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertHarnessCompletionSourceAdmission,
  createAgentHarnessCompletionScope,
} from "../agents/agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  loadRequester: vi.fn(),
  reconcile: vi.fn(() => "unowned"),
  resolveCompletionOrigin: vi.fn(async () => undefined),
}));
vi.mock("../agents/agent-harness-completion-delivery.js", () => ({
  reconcileHarnessCompletionDelivery: mocks.reconcile,
}));
vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: mocks.deliver,
  loadRequesterSessionEntry: mocks.loadRequester,
  isInternalAnnounceRequesterSession: () => false,
}));
vi.mock("../agents/subagents/announce/subagent-announce-origin.js", () => ({
  resolveAnnounceOrigin: () => ({ channel: "test", to: "requester" }),
  resolveSubagentCompletionOrigin: mocks.resolveCompletionOrigin,
}));
import { deliverAgentHarnessCompletion } from "./agent-harness-completion.js";

const source = {
  requesterSessionKey: "main",
  requesterAgentId: "alternate",
  requesterSessionId: "requester-1",
  requesterLifecycleRevision: "revision-1",
  sourceSessionKey: "native-child:one",
  sourceRunId: buildAnnounceIdempotencyKey("native-result"),
};
function params() {
  return {
    scope: createAgentHarnessCompletionScope(source),
    childSessionKey: source.sourceSessionKey,
    childSessionId: "native-thread",
    announceId: "native-result",
    status: "succeeded" as const,
    result: "Child result",
    isSourceSessionAdmissionAllowed: () => true,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.reconcile.mockReturnValue("unowned");
  mocks.resolveCompletionOrigin.mockImplementation(async () => undefined);
  mocks.loadRequester.mockReturnValue({
    entry: {
      sessionId: source.requesterSessionId,
      lifecycleRevision: source.requesterLifecycleRevision,
    },
    canonicalKey: source.requesterSessionKey,
    agentId: source.requesterAgentId,
    storePath: "/isolated/alternate/sessions.json",
  });
  mocks.deliver.mockImplementation(async () => {
    assertHarnessCompletionSourceAdmission(source);
    return { delivered: true, path: "direct" };
  });
});

describe("SDK harness completion source admission", () => {
  it("carries exact host authority through the registered delivery entrypoint and closes it afterward", async () => {
    let retained: (() => void) | undefined;
    mocks.deliver.mockImplementation(async () => {
      await Promise.resolve();
      retained = assertHarnessCompletionSourceAdmission(source);
      expect(() =>
        assertHarnessCompletionSourceAdmission({ ...source, sourceRunId: "forged" }),
      ).toThrow("exact host-issued");
      expect(() =>
        assertHarnessCompletionSourceAdmission({ ...source, requesterAgentId: "main" }),
      ).toThrow("exact host-issued");
      return { delivered: true, path: "direct" };
    });
    await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
      delivered: true,
    });
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterAgentId: "alternate",
        requesterSessionKey: "main",
        sourceSessionKey: source.sourceSessionKey,
        directIdempotencyKey: source.sourceRunId,
        sourceTool: "agent_harness_completion",
      }),
    );
    expect(
      mocks.loadRequester.mock.calls.every(
        ([key, agentId]) => key === "main" && agentId === "alternate",
      ),
    ).toBe(true);
    expect(retained).toBeDefined();
    expect(() => retained!()).toThrow("source owner retired");
    expect(() => assertHarnessCompletionSourceAdmission(source)).toThrow("exact host-issued");
  });

  it("rejects copied scopes and retired source owners before announcement", async () => {
    const input = params();
    await expect(
      deliverAgentHarnessCompletion({ ...input, scope: { ...input.scope } }),
    ).rejects.toThrow("host-issued scope");
    await expect(
      deliverAgentHarnessCompletion({ ...input, isSourceSessionAdmissionAllowed: () => false }),
    ).rejects.toThrow("source owner retired");
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("rechecks source authority after asynchronous delivery work", async () => {
    let current = true;
    mocks.deliver.mockImplementation(async () => {
      const assertCurrent = assertHarnessCompletionSourceAdmission(source);
      await Promise.resolve();
      current = false;
      assertCurrent();
    });
    await expect(
      deliverAgentHarnessCompletion({
        ...params(),
        isSourceSessionAdmissionAllowed: () => current,
      }),
    ).rejects.toThrow("source owner retired");
  });

  it.each(["pending", "delivered", "blocked"])(
    "honors existing %s requester custody without admitting a second source",
    async (custody) => {
      mocks.reconcile.mockReturnValue(custody);
      const result = await deliverAgentHarnessCompletion({
        ...params(),
        isSourceSessionAdmissionAllowed: () => false,
      });
      expect(result.delivered).toBe(custody === "delivered");
      expect(result.recoveryPending === true).toBe(custody === "pending");
      expect(result.recoveryBlocked === true).toBe(custody === "blocked");
      expect(mocks.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: source.requesterAgentId,
          sessionKey: source.requesterSessionKey,
          sourceRunId: source.sourceRunId,
          taskRunId: source.sourceSessionKey,
        }),
      );
      expect(mocks.deliver).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "session", "revision"])(
    "blocks %s requester after awaited origin resolution",
    async (kind) => {
      mocks.resolveCompletionOrigin.mockImplementation(async () => {
        mocks.loadRequester.mockReturnValue({
          entry:
            kind === "missing"
              ? undefined
              : {
                  sessionId: kind === "session" ? "successor" : source.requesterSessionId,
                  lifecycleRevision:
                    kind === "revision" ? "successor" : source.requesterLifecycleRevision,
                },
        });
        return undefined;
      });
      await expect(deliverAgentHarnessCompletion(params())).resolves.toMatchObject({
        delivered: false,
        recoveryBlocked: true,
      });
      expect(mocks.deliver).not.toHaveBeenCalled();
    },
  );
});
