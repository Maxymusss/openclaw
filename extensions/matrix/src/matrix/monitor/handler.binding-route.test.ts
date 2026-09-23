import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  registerSessionBindingAdapter,
  testing as bindingTesting,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { expect, it, vi } from "vitest";
import { matrixPlugin } from "../../channel.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { createMatrixMonitorEventsTestHarness } from "./events.test-helpers.js";
import {
  createMatrixHandlerTestHarness,
  installMatrixHandlerTestFixture,
  matrixCaseConfig,
  registerMatrixTestRelease,
  waitForMatrixTestSignal,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

const matrixFixture = installMatrixHandlerTestFixture();

// Provisioning is a separate ACP contract. The real shared dispatch guard and
// registered terminal hook below exercise the configured route's observation.
vi.mock("openclaw/plugin-sdk/acp-binding-runtime", () => ({
  ensureConfiguredAcpBindingReady: vi.fn(async () => ({ ok: true })),
}));

let cleanup: (() => Promise<void>) | undefined;
matrixFixture.afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  bindingTesting.resetSessionBindingAdaptersForTests();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it.for([
  "none-to-global",
  "plugin-to-global",
  "configured-stable",
  "configured-to-global",
] as const)(
  "preserves Matrix's prepared owner through a registered message: %s",
  matrixFixture.wrapCase(async (scenario, context) => {
    const state = matrixFixture.state;
    const roomId = "!route:example.org";
    const senderId = "@sender:example.org";
    const configured = scenario.startsWith("configured");
    const transition = scenario !== "configured-stable";
    const bindings: OpenClawConfig["bindings"] = configured
      ? [
          {
            type: "acp",
            agentId: "configured",
            match: {
              channel: "matrix",
              accountId: "ops",
              peer: { kind: "channel", id: roomId },
            },
          },
        ]
      : undefined;
    const cfg: OpenClawConfig = matrixCaseConfig({
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: state.path("main-workspace") },
          work: { workspace: state.path("work-workspace") },
          configured: { workspace: state.path("configured-workspace") },
        },
        defaults: { skipBootstrap: true, workspace: state.workspaceDir },
      },
      channels: { matrix: { dm: { policy: "open", allowFrom: ["*"] }, groupPolicy: "open" } },
      plugins: { enabled: true, allow: ["matrix"], entries: { matrix: { enabled: true } } },
      acp: { enabled: true, dispatch: { enabled: true } },
      ...(bindings ? { bindings } : {}),
    });
    installMatrixMonitorTestRuntime({ cfg, stateDir: state.stateDir });
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntimeMock(),
      activateGlobalSideEffects: false,
    });
    cleanup = () => disposePluginRegistryInstances(builder.registry);
    const record = createPluginRecord({ id: "matrix", origin: "bundled", status: "loaded" });
    const api = builder.createApi(record, { config: cfg });
    builder.registry.plugins.push(record);
    defineChannelPluginEntry({
      id: matrixPlugin.id,
      name: matrixPlugin.meta.label,
      description: matrixPlugin.meta.blurb,
      plugin: matrixPlugin,
    }).register(api);
    const terminal = vi.fn<(agentId: string | undefined, sessionKey: string | undefined) => void>();
    api.on(
      "reply_dispatch",
      async (event, context) => {
        terminal(event.ctx.AgentId, event.sessionKey);
        context.recordProcessed("completed", { reason: "synthetic-matrix-route-boundary" });
        context.markIdle("message_completed");
        return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
      { eligibleDispatchKinds: ["agent", "acp"] },
    );
    setActivePluginRegistry(builder.registry);
    initializeGlobalHookRunner(builder.registry);

    const conversation = { channel: "matrix", accountId: "ops", conversationId: roomId };
    const replacement: SessionBindingRecord = {
      bindingId: "matrix-route-owner",
      boundAt: 2,
      targetKind: "session",
      targetSessionKey: "global",
      conversation,
      status: "active",
      metadata: { agentId: "work" },
    };
    let current: SessionBindingRecord | null =
      scenario === "plugin-to-global"
        ? {
            ...replacement,
            boundAt: 1,
            targetSessionKey: "plugin-binding:matrix:source",
            metadata: {
              pluginBindingOwner: "plugin",
              pluginId: "synthetic-owner",
              pluginRoot: state.path("plugin"),
            },
          }
        : null;
    const inspect = vi.fn(() => current);
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "ops",
      listBySession: () => (current ? [current] : []),
      inspectByConversation: inspect,
      resolveByConversation: () => current,
      resolveByConversationAsync: async () => current,
      touch,
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    registerMatrixTestRelease(release.resolve);
    let pause = true;
    const commit = vi.fn(async () => true);
    const releaseClaim = vi.fn();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { handler } = createMatrixHandlerTestHarness({
      cfg,
      runtime,
      isDirectMessage: false,
      resolveAgentRoute: () => ({
        agentId: "main",
        channel: "matrix",
        accountId: "ops",
        sessionKey: "agent:main:matrix:room",
        mainSessionKey: "agent:main:main",
        matchedBy: "binding.account",
      }),
      inboundDeduper: {
        claim: async () => ({
          kind: "claimed",
          handle: { keys: [scenario], commit, release: releaseClaim },
        }),
      },
      getMemberDisplayName: async (_room, userId) => {
        if (pause && userId === senderId) {
          pause = false;
          entered.resolve();
          await release.promise;
        }
        return "synthetic sender";
      },
      runChannelInboundEvent: (params) =>
        withPluginRuntimeRegistryScope(builder.registry, () =>
          runChannelInboundEvent({
            ...params,
            adapter: {
              ...params.adapter,
              resolveTurn: async (...args) => {
                const turn = await params.adapter.resolveTurn(...args);
                if (!("delivery" in turn)) {
                  throw new Error("Expected Matrix delivery plan");
                }
                return {
                  ...turn,
                  replyResolver: async () => {
                    throw new Error("Synthetic terminal hook was not selected");
                  },
                  delivery: {
                    ...turn.delivery,
                    deliver: async () => {
                      throw new Error("The terminal fixture must not send a provider message");
                    },
                  },
                };
              },
            },
          }),
        ),
    });
    const monitor = createMatrixMonitorEventsTestHarness({
      cfg,
      accountId: "ops",
      onRoomMessage: handler,
    });
    // Later finished hooks run first: join this callback before the event harness removes its state.
    context.onTestFinished(async () => {
      release.resolve();
      await matrixFixture.joinCase();
    });
    try {
      const event = createMatrixTextMessageEvent({
        eventId: `$matrix-route-${scenario}`,
        sender: senderId,
        body: "@room continue",
        mentions: { room: true },
      });
      const emit = () => {
        monitor.roomMessageListener(roomId, event);
        return monitor.flushTasks();
      };
      const first = emit();
      await waitForMatrixTestSignal(entered.promise, first);
      expect(inspect).toHaveBeenCalled();
      expect(touch).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
      if (transition) {
        current = replacement;
      }
      release.resolve();
      await first;

      if (transition) {
        expect(terminal).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(releaseClaim).toHaveBeenCalledOnce();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Conversation binding changed while preparing the reply"),
        );
        await emit();
        expect(terminal).toHaveBeenCalledExactlyOnceWith("work", "global");
      } else {
        expect(runtime.error).not.toHaveBeenCalled();
        expect(releaseClaim).not.toHaveBeenCalled();
        expect(terminal).toHaveBeenCalledExactlyOnceWith(
          "configured",
          expect.stringContaining("agent:configured:acp:binding:matrix:ops:"),
        );
      }
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      try {
        await monitor.flushTasks();
      } finally {
        await monitor.dispose();
      }
    }
  }),
);
