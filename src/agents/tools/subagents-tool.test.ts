import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createSubagentsTool } from "./subagents-tool.js";
const owner = vi.hoisted(() => ({
  runs: [] as SubagentRunRecord[],
  listeners: new Set<() => void>(),
  cancel: vi.fn(),
}));
vi.mock("../subagents/registry/subagent-control.js", () => ({
  DEFAULT_RECENT_MINUTES: 30,
  MAX_RECENT_MINUTES: 1440,
  resolveSubagentController: () => ({
    controllerSessionKey: "agent:main:main",
    controllerAgentId: "main",
    callerSessionKey: "agent:main:main",
    callerIsSubagent: false,
    controlScope: "children",
  }),
  buildControlledSubagentRunsReadContext: async () => ({ list: {} }),
  killSubagentRunAdmin: owner.cancel,
}));
vi.mock("../subagents/registry/subagent-control-scope.js", () => ({
  ensureSubagentControllerOwnsRun: () => undefined,
  listControlledSubagentRunFacts: (key: string) =>
    owner.runs.filter((entry) => entry.requesterSessionKey === key),
}));
vi.mock("../subagents/registry/subagent-registry-state.js", () => ({
  getSubagentSessionListReadSnapshotIdentity: () => "ready",
  prepareSubagentSessionListReadCache: async () => {},
  prepareSubagentRunsSnapshotForRunIds: async () => ({
    consume: (read: (snapshot: ReadonlyMap<string, SubagentRunRecord>) => unknown) => ({
      ready: true,
      value: read(new Map(owner.runs.map((entry) => [entry.runId, entry]))),
    }),
  }),
  onSubagentRegistryPersisted: (listener: () => void) => {
    owner.listeners.add(listener);
    return () => owner.listeners.delete(listener);
  },
}));
vi.mock("../subagents/registry/subagent-list.js", () => ({
  readSubagentListSessionEntries: () => new Map(),
  buildSubagentList: () => ({
    total: owner.runs.length,
    active: [],
    recent: [],
    text: "native subagents",
  }),
}));
beforeEach(() => {
  owner.runs = [];
  owner.listeners.clear();
  owner.cancel.mockReset();
});
function run() {
  const entry = createSubagentRunRecord({
    runId: "native-one",
    childSessionKey: "agent:main:subagent:one",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    generation: 1,
  });
  owner.runs = [entry];
  return entry;
}
function tool() {
  return createSubagentsTool({ config: {}, agentId: "main", agentSessionKey: "agent:main:main" });
}
describe("subagents native run contract", () => {
  it("subscribes before reading and does not consume the completed result's delivery obligation", async () => {
    const entry = run();
    entry.delivery = { status: "pending" };
    const pending = tool().execute("wait", { action: "wait", runIds: [entry.runId] });
    expect(owner.listeners.size).toBe(1);
    entry.execution = { status: "terminal", endedAt: 100, outcome: { status: "ok" } };
    for (const emit of owner.listeners) {
      emit();
    }
    expect((await pending).details).toMatchObject({
      reason: "completed",
      completed: [entry.runId],
      runs: [{ runId: entry.runId, deliveryStatus: "pending" }],
    });
    expect(owner.listeners.size).toBe(0);
    expect(entry.delivery.status).toBe("pending");
  });
  it("zero-timeout and abort do not cancel execution", async () => {
    const entry = run();
    expect(
      (await tool().execute("wait", { action: "wait", runIds: [entry.runId], timeoutSeconds: 0 }))
        .details,
    ).toMatchObject({ reason: "timeout" });
    const controller = new AbortController();
    const pending = tool().execute(
      "wait",
      { action: "wait", runIds: [entry.runId] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(owner.cancel).not.toHaveBeenCalled();
    expect(owner.listeners.size).toBe(0);
  });
  it("never lets a revoked controller selection cancel after an await", async () => {
    const entry = run();
    owner.cancel.mockImplementation(
      async (_params: unknown, control: { assertCurrent: () => void }) => {
        control.assertCurrent();
        owner.runs = [];
        await Promise.resolve();
        control.assertCurrent();
      },
    );
    await expect(
      tool().execute("cancel", { action: "cancel", runId: entry.runId }),
    ).rejects.toThrow("cancellation owner changed");
  });
});
