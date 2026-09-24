import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import { rolePolicyConfig, sharingPolicyClient } from "../../gateway/session-sharing.test-utils.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { DetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-contract.js";
import { getRegisteredDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime-state.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.test-support.js";
import type { FollowupRequest } from "../../tasks/task-followup-completion.types.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup.js";
const mocks = vi.hoisted(() => ({
  config: vi.fn<() => OpenClawConfig>(),
  client: vi.fn<() => GatewayClient | null>(),
  capture: vi.fn(),
  prepare: vi.fn(),
  profile: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.config }));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  captureOperatorToolGatewayContinuationContext: mocks.capture,
}));
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.prepare,
  SessionMutationFactsUnavailableError: class extends Error {},
}));
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ client: mocks.client() }),
  getPluginRegistryForContext: () => getActivePluginRegistry(),
}));
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: mocks.profile,
}));
vi.mock("./gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => ({ agentId: "main", sessionKey: "agent:main:requester" }),
  captureGatewayToolCallerAssertion: () => () => {},
}));
const input = {
  runId: "followup",
  requesterAgentId: "main",
  requesterSessionKey: "agent:main:requester",
  targetAgentId: "main",
  targetSessionKey: "agent:main:worker",
};
const facts = new Map<string, PreparedSessionMutationFacts>();
const active: FollowupRequest[] = [];
beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  mocks.config.mockReturnValue({ ...rolePolicyConfig(), agents: { entries: { main: {} } } });
  mocks.client.mockReturnValue(sharingPolicyClient({ user: "requester" }));
  mocks.profile.mockResolvedValue({
    profileId: "requester",
    role: "view",
    aliases: ["requester"],
    isCurrent: () => true,
  });
  mocks.capture.mockReturnValue({
    signal: new AbortController().signal,
    release: mocks.release,
    run: (work: () => unknown) => work(),
  });
  facts.clear();
  for (const sessionKey of [input.requesterSessionKey, input.targetSessionKey]) {
    facts.set(sessionKey, {
      membership: new Set(["requester"]),
      target: {
        agentId: "main",
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        storePath: "/synthetic/agent.sqlite",
        entry: {
          sessionId: sessionKey + "-id",
          lifecycleRevision: "one",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: {
            type: "human",
            source: "profile",
            id: sessionKey === input.requesterSessionKey ? "requester" : "other",
          },
        },
      },
    });
  }
  mocks.prepare.mockImplementation(async ({ sessionKey }: { sessionKey: string }) => ({
    readCurrent: () => facts.get(sessionKey),
    release: () => {},
  }));
});
afterEach(async () => {
  for (const request of active.splice(0)) {
    request.custody.release();
  }
  await clearActivePluginRegistry();
  vi.clearAllMocks();
});
async function prepare() {
  const request = await prepareSessionsSendFollowup(input);
  if (!request) {
    throw new Error("Expected admitted followup custody");
  }
  active.push(request);
  return request;
}
function target() {
  const value = facts.get(input.targetSessionKey);
  if (!value?.target) {
    throw new Error("Missing fixture target");
  }
  return value;
}
describe("followup retained session authorization", () => {
  it("keeps a registered task runtime on its existing path before capturing core custody", async () => {
    const runtime: DetachedTaskLifecycleRuntime = {
      createQueuedTaskRun: vi.fn(() => null),
      createRunningTaskRun: vi.fn(() => null),
      startTaskRunByRunId: vi.fn(() => []),
      recordTaskRunProgressByRunId: vi.fn(() => []),
      completeTaskRunByRunId: vi.fn(() => []),
      failTaskRunByRunId: vi.fn(() => []),
      setDetachedTaskDeliveryStatusByRunId: vi.fn(() => []),
      cancelDetachedTaskRunById: vi.fn(async () => ({ found: false, cancelled: false })),
    };
    setDetachedTaskLifecycleRuntime(runtime, "registered-owner");
    expect(getRegisteredDetachedTaskLifecycleRuntime()).toBe(runtime);
    await expect(prepareSessionsSendFollowup(input)).resolves.toBeUndefined();
    expect(runtime.createRunningTaskRun).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("uses the original operator and current prepared membership, and latches revocation", async () => {
    const request = await prepare();
    expect(() => request.custody.assertCurrent()).not.toThrow();
    target().membership = new Set();
    sessionChanges.emit({ sessionKey: input.targetSessionKey });
    expect(request.custody.signal.aborted).toBe(true);
    target().membership = new Set(["requester"]);
    sessionChanges.emit({ sessionKey: input.targetSessionKey });
    expect(() => request.custody.assertCurrent()).toThrow("revoked");
  });
  it("rejects an archived or replaced target without using the same key as authority", async () => {
    const request = await prepare();
    const row = target().target;
    if (!row) {
      throw new Error("Missing target");
    }
    row.entry.archivedAt = 2;
    sessionChanges.emit({ sessionKey: input.targetSessionKey });
    expect(() => request.custody.assertCurrent()).toThrow("archived");
    delete row.entry.archivedAt;
    expect(() => request.custody.assertCurrent()).toThrow();
  });
  it("refuses missing captured authority rather than selecting a System caller", async () => {
    mocks.capture.mockReturnValue(undefined);
    await expect(prepareSessionsSendFollowup(input)).rejects.toThrow("in-process caller custody");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
