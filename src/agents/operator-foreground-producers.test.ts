import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeSystem } from "../plugins/runtime/runtime-system.js";
import { enqueueSystemEventFromSdk } from "../plugins/runtime/system-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  assertOperatorBackgroundWorkAllowed,
  isOperatorForegroundWork,
} from "./operator-foreground-work.js";
import { spawnAcpDirect } from "./subagents/spawn/acp-spawn.js";
import * as spawnRequest from "./subagents/spawn/subagent-spawn-request.js";
import { spawnSubagentDirect } from "./subagents/spawn/subagent-spawn.js";
import { createCronTool } from "./tools/cron-tool.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createCreateGoalTool } from "./tools/goal-tools.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { maybeSpawnVisibleSession } from "./tools/sessions-spawn-visible.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

afterEach(() => vi.restoreAllMocks());

const sessionKey = "agent:main:foreground-producer";
const foregroundWorkError = {
  asymmetricMatch(value: unknown): boolean {
    return (
      value instanceof Error &&
      value.name === "OperatorForegroundWorkError" &&
      value.message ===
        "This access permits one foreground turn only. Finish this turn and ask the user for a new request; background or resumed work is unavailable."
    );
  },
};
function withForeground<T>(run: () => Promise<T>) {
  const operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "foreground-person",
    scopes: ["operator.sessions.write"],
    executionPolicy: "foreground-only",
    assertCurrent() {},
  });
  return withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey, operatorAuthority },
    // Same-run wrappers must not erase the original restriction.
    () => withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, run),
  );
}

it("preserves explicit no-policy access without clearing the inherited foreground restriction", async () => {
  const source = { accessAuthority: null };
  expect(isOperatorForegroundWork(source)).toBe(false);
  expect(() => assertOperatorBackgroundWorkAllowed(source)).not.toThrow();
  await withForeground(async () => {
    expect(isOperatorForegroundWork(source)).toBe(true);
    expect(() => assertOperatorBackgroundWorkAllowed(source)).toThrow(foregroundWorkError);
  });
});

it("refuses hidden, collector, ACP and visible children before reservation or setup", async () => {
  const resolve = vi.spyOn(spawnRequest, "resolveSubagentSpawnRequest");
  const effects = vi.fn();
  const ctx = { agentSessionKey: sessionKey, onSpawnEffectsStart: effects };
  await withForeground(async () => {
    for (const collect of [false, true]) {
      await expect(spawnSubagentDirect({ task: "child task", collect }, ctx)).rejects.toThrow(
        foregroundWorkError,
      );
    }
    await expect(spawnAcpDirect({ task: "ACP task" }, ctx)).rejects.toThrow(foregroundWorkError);
    await expect(
      maybeSpawnVisibleSession({
        raw: { visible: true },
        task: "visible task",
        label: "child",
        runtime: "subagent",
        sandbox: "inherit",
        expectsCompletionMessage: true,
      }),
    ).rejects.toThrow(foregroundWorkError);
  });
  expect(resolve).not.toHaveBeenCalled();
  expect(effects).not.toHaveBeenCalled();
});

it("refuses cross-session send, goal and yield effects before calling their owners", async () => {
  const gateway = vi.fn();
  const claimYield = vi.fn();
  const onYield = vi.fn();
  const send = createSessionsSendTool({
    callGateway: async () => {
      gateway();
      throw new Error("unexpected Gateway call");
    },
  });
  await withForeground(async () => {
    for (const mode of ["notify", "steer", "followup", "resume"]) {
      await expect(
        send.execute("send", {
          message: "continue elsewhere",
          sessionKey: "agent:main:other",
          mode,
        }),
      ).rejects.toThrow(foregroundWorkError);
    }
    await expect(
      createCreateGoalTool({ agentSessionKey: sessionKey }).execute("goal", {
        objective: "keep working",
      }),
    ).rejects.toThrow(foregroundWorkError);
    await expect(
      createSessionsYieldTool({ sessionId: "source", claimYield, onYield }).execute("yield", {}),
    ).rejects.toThrow(foregroundWorkError);
  });
  expect(gateway).not.toHaveBeenCalled();
  expect(claimYield).not.toHaveBeenCalled();
  expect(onYield).not.toHaveBeenCalled();
});

it("blocks scheduled work and direct plugin wake/process alternatives before their effects", async () => {
  const gateway = vi.fn();
  const tool = createCronTool(
    {},
    {
      callGatewayTool: async () => {
        gateway();
        throw new Error("unexpected Gateway call");
      },
    },
  );
  const system = createRuntimeSystem();
  await withForeground(async () => {
    for (const action of ["add", "run", "next_check", "wake"]) {
      await expect(
        tool.execute("schedule", { action, jobId: "existing-job", text: "later work" }),
      ).rejects.toThrow(foregroundWorkError);
    }
    expect(() => enqueueSystemEventFromSdk("later work", { sessionKey })).toThrow(
      foregroundWorkError,
    );
    expect(() => system.requestHeartbeatNow({ sessionKey })).toThrow(foregroundWorkError);
    expect(() => system.runHeartbeatOnce({ sessionKey })).toThrow(foregroundWorkError);
    expect(() => system.runCommandWithTimeout(["echo", "unexpected"], { timeoutMs: 100 })).toThrow(
      foregroundWorkError,
    );
  });
  expect(gateway).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains automation observation with restricted source %s",
  async (restricted) => {
    await withOpenClawTestState({ label: "foreground-observation" }, async () => {
      const reachedGateway = new Error("original read owner reached");
      const gateway = vi.fn(async () => {
        throw reachedGateway;
      });
      const tool = createCronTool({}, { callGatewayTool: gateway });
      const read = () =>
        expect(tool.execute("status", { action: "status" })).rejects.toBe(reachedGateway);
      if (restricted) {
        await withForeground(read);
      } else {
        await read();
      }
      expect(gateway).toHaveBeenCalledOnce();
    });
  },
);
