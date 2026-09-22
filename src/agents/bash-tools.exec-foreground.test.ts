import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as surface from "../infra/exec-approval-surface.js";
import {
  ensureExecApprovalsSnapshot,
  readExecApprovalsSnapshot,
} from "../infra/exec-approvals-store.js";
import * as hookRuntime from "../plugins/hook-runner-global.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import * as processRegistry from "./bash-process-registry.js";
import { listRunningSessions } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import * as registration from "./bash-tools.exec-approval-request.js";
import { processGatewayAllowlist } from "./bash-tools.exec-host-gateway.js";
import * as nodeHost from "./bash-tools.exec-host-node.js";
import * as hostSpawn from "./bash-tools.exec-host-spawn.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetProcessRegistryForTests();
});

function authority(signal = new AbortController().signal) {
  return createAdmittedRunOperatorAuthority({
    profileId: "foreground-exec-person",
    scopes: ["operator.sessions.write"],
    executionPolicy: "foreground-only",
    signal,
    assertCurrent: () => signal.throwIfAborted(),
  });
}

it("retains its original restriction across lazy loading and refuses unsupported intent before effects", async () => {
  const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
  const register = vi.spyOn(registration, "registerExecApprovalRequestForHostOrThrow");
  const node = vi.spyOn(nodeHost, "executeNodeHostCommand");
  const running = listRunningSessions();
  for (const params of [
    { command: "echo should-not-execute", background: true },
    { command: "echo should-not-execute", yieldMs: 1 },
    { command: "echo should-not-execute", host: "node" },
    { command: "echo should-not-execute", host: "sandbox" },
  ]) {
    const tool = createLazyExecTool(
      {
        host: params.host === "node" ? "node" : params.host === "sandbox" ? "sandbox" : "gateway",
        mode: "full",
        ask: "off",
      },
      undefined,
      authority(),
    );
    await expect(tool.execute("refused-exec", params)).rejects.toThrow(/foreground|Foreground/);
    await expect(tool.prepareBeforeToolCallParams?.(params, {})).rejects.toThrow(
      /foreground|Foreground/,
    );
  }
  const sandbox = createLazyExecTool(
    { host: "gateway", sandboxRequired: true },
    undefined,
    authority(),
  );
  await expect(
    sandbox.execute("required-sandbox", { command: "echo should-not-execute" }),
  ).rejects.toThrow("requires a sandbox");
  const followup = createLazyExecTool(
    { host: "gateway", approvalFollowupMode: "direct" },
    undefined,
    authority(),
  );
  await expect(
    followup.execute("detached-approval", { command: "echo should-not-execute" }),
  ).rejects.toThrow("foreground commands only");
  expect(spawn).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
  expect(node).not.toHaveBeenCalled();
  expect(listRunningSessions()).toEqual(running);
});

it("checks original source revocation before a retained lazy callback can execute", async () => {
  const source = new AbortController();
  const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
  const tool = createLazyExecTool(
    { host: "gateway", mode: "full" },
    undefined,
    authority(source.signal),
  );
  const reason = new Error("original visitor source revoked");
  source.abort(reason);
  await expect(tool.execute("revoked-exec", { command: "echo should-not-execute" })).rejects.toBe(
    reason,
  );
  expect(spawn).not.toHaveBeenCalled();
});

it.each([false, true])(
  "rechecks its original source after an env hook outside caller context (bypass=%s)",
  async (bypassHostApprovalFloors) => {
    await withOpenClawTestState({ label: "foreground-exec-env-revocation" }, async () => {
      const entered = createDeferred();
      const release = createDeferred();
      const source = new AbortController();
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "resolve_exec_env",
            handler: async () => {
              entered.resolve();
              await release.promise;
              return {};
            },
          },
        ]),
      );
      vi.spyOn(hookRuntime, "getGlobalHookRunner").mockReturnValue(runner);
      const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
      const reserve = vi.spyOn(processRegistry, "addSession");
      const register = vi.spyOn(registration, "registerExecApprovalRequestForHostOrThrow");
      const tool = createLazyExecTool(
        {
          host: "gateway",
          mode: "full",
          ask: "off",
          bypassHostApprovalFloors,
        },
        undefined,
        authority(source.signal),
      );
      // Deliberately no caller ALS or tool AbortSignal: the retained tool owns
      // the original person's authority across this asynchronous preparation.
      const pending = tool.execute("env-revoked", { command: "echo should-not-execute" });
      const reason = new Error("source revoked while env was resolving");
      try {
        await Promise.race([entered.promise, pending]);
        source.abort(reason);
        release.resolve();
        await expect(pending).rejects.toBe(reason);
        expect(reserve).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    });
  },
);

function requestApproval(operatorAuthority = authority()) {
  return processGatewayAllowlist({
    operatorAuthority,
    command: "echo approval-proof",
    workdir: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    pty: false,
    defaultTimeoutSec: 30,
    security: "full",
    ask: "always",
    bypassHostApprovalFloors: true,
    safeBins: new Set(),
    safeBinProfiles: {},
    warnings: [],
    approvalRunningNoticeMs: 0,
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    turnSourceChannel: "webchat",
  });
}

it("rechecks original authority at final spawn after asynchronous native preparation", async () => {
  await withOpenClawTestState({ label: "foreground-exec-final-spawn" }, async () => {
    const source = new AbortController();
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = hostSpawn.prepareHostExecSpawn;
    vi.spyOn(hostSpawn, "prepareHostExecSpawn").mockImplementation(async (params) => {
      const prepared = await prepare(params);
      entered.resolve();
      await release.promise;
      return prepared;
    });
    const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
    const reserve = vi.spyOn(processRegistry, "addSession");
    const tool = createLazyExecTool(
      {
        host: "gateway",
        mode: "full",
        ask: "off",
        bypassHostApprovalFloors: true,
        notifyOnExit: false,
      },
      undefined,
      authority(source.signal),
    );
    const pending = tool.execute("final-spawn-revoked", { command: "echo should-not-execute" });
    const reason = new Error("source revoked during native preparation");
    try {
      await Promise.race([entered.promise, pending]);
      expect(reserve).toHaveBeenCalledOnce();
      source.abort(reason);
      release.resolve();
      await expect(pending).rejects.toBe(reason);
      expect(spawn).not.toHaveBeenCalled();
      expect(listRunningSessions()).toEqual([]);
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });
});

it.each(["allow-once", "allow-always"] as const)(
  "rejects %s after inline approval loses its original source without writing or launching",
  async (decisionValue) => {
    await withOpenClawTestState({ label: "foreground-exec-inline-revocation" }, async () => {
      const source = new AbortController();
      vi.spyOn(surface, "resolveExecApprovalInitiatingSurfaceState").mockReturnValue({
        kind: "enabled",
        channel: "webchat",
        channelLabel: "Web UI",
      });
      const register = vi
        .spyOn(registration, "registerExecApprovalRequestForHostOrThrow")
        .mockImplementation(async ({ approvalId }) => ({
          id: approvalId,
          expiresAtMs: Date.now() + 60_000,
        }));
      const entered = createDeferred();
      const decision = createDeferred<string | null>();
      vi.spyOn(registration, "resolveRegisteredExecApprovalDecision").mockImplementation(() => {
        entered.resolve();
        return decision.promise;
      });
      const before = await ensureExecApprovalsSnapshot();
      const reserve = vi.spyOn(processRegistry, "addSession");
      const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
      const pending = requestApproval(authority(source.signal));
      const reason = new Error("original source revoked during inline approval");
      try {
        await Promise.race([entered.promise, pending]);
        expect(register).toHaveBeenCalledOnce();
        expect(readExecApprovalsSnapshot()).toEqual(before);
        source.abort(reason);
        decision.resolve(decisionValue);
        await expect(pending).rejects.toBe(reason);
        expect(readExecApprovalsSnapshot()).toEqual(before);
        expect(reserve).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        decision.resolve("deny");
        await pending.catch(() => {});
      }
    });
  },
);

it.each(["disabled", "unsupported"] as const)(
  "refuses known %s approval surfaces before registration or process reservation",
  async (kind) => {
    await withOpenClawTestState({ label: "foreground-exec-approval" }, async () => {
      vi.spyOn(surface, "resolveExecApprovalInitiatingSurfaceState").mockReturnValue({
        kind,
        channel: "webchat",
        channelLabel: "Web UI",
      });
      const register = vi.spyOn(registration, "registerExecApprovalRequestForHostOrThrow");
      const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
      const running = listRunningSessions();
      await expect(requestApproval()).rejects.toThrow("cannot detach an approval");
      expect(register).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(listRunningSessions()).toEqual(running);
    });
  },
);

it("keeps an approval inline if its surface disappears after registration", async () => {
  await withOpenClawTestState({ label: "foreground-exec-approval-race" }, async () => {
    const availability = vi
      .spyOn(surface, "resolveExecApprovalInitiatingSurfaceState")
      .mockReturnValue({ kind: "enabled", channel: "webchat", channelLabel: "Web UI" });
    const register = vi
      .spyOn(registration, "registerExecApprovalRequestForHostOrThrow")
      .mockImplementation(async ({ approvalId }) => {
        availability.mockReturnValue({
          kind: "disabled",
          channel: "webchat",
          channelLabel: "Web UI",
        });
        return { id: approvalId, expiresAtMs: Date.now() + 60_000 };
      });
    const decision = createDeferred<string | null>();
    const waiting = createDeferred();
    vi.spyOn(registration, "resolveRegisteredExecApprovalDecision").mockImplementation(() => {
      waiting.resolve();
      return decision.promise;
    });
    const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
    let settled = false;
    const pending = requestApproval().then((result) => {
      settled = true;
      return result;
    });
    try {
      await Promise.race([waiting.promise, pending]);
      expect(register).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
      decision.resolve("deny");
      expect((await pending).deniedResult?.details.status).toBe("failed");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      decision.resolve("deny");
      await pending;
    }
  });
});

it("preserves the canonical terminal no-route inline denial", async () => {
  await withOpenClawTestState({ label: "foreground-exec-no-route" }, async () => {
    vi.spyOn(registration, "registerExecApprovalRequestForHostOrThrow").mockImplementation(
      async ({ approvalId }) => ({ id: approvalId, expiresAtMs: Date.now(), finalDecision: null }),
    );
    const wait = vi.spyOn(registration, "resolveRegisteredExecApprovalDecision");
    const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
    await expect(requestApproval()).rejects.toThrow("denied");
    expect(wait).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
