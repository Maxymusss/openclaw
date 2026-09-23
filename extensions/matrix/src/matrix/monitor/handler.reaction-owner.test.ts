import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  installMatrixHandlerTestFixture,
  matrixCaseConfig,
  registerMatrixTestRelease,
  waitForMatrixTestSignal,
  createMatrixReactionEvent,
} from "./handler.test-helpers.js";

const matrixFixture = installMatrixHandlerTestFixture();

beforeEach(() => {
  installMatrixMonitorTestRuntime({
    cfg: matrixCaseConfig(),
    stateDir: matrixFixture.state.stateDir,
  });
  resetSystemEventsForTest();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});
matrixFixture.afterEach(() => {
  resetSystemEventsForTest();
  clearRuntimeConfigSnapshot();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("Matrix reaction ownership", () => {
  it(
    "keeps a reaction on the runtime-bound global owner's queue",
    matrixFixture.wrapCase(async () => {
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "research" }] },
        channels: { matrix: { dm: { allowFrom: ["*"] } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const binding = {
        bindingId: "reaction-owner",
        targetSessionKey: "global",
        targetKind: "session" as const,
        conversation: { channel: "matrix", accountId: "ops", conversationId: "!room:example.org" },
        status: "active" as const,
        boundAt: 1,
        metadata: { agentId: "research" },
      };
      registerSessionBindingAdapter({
        ...binding.conversation,
        listBySession: () => [binding],
        resolveByConversation: () => binding,
      });
      const { handler, recordedTurn, resolvedTurn } = createMatrixHandlerTestHarness({
        cfg,
        client: { getEvent: async () => ({ sender: "@bot:example.org" }) },
        getMemberDisplayName: async () => "sender",
      });

      await handler(
        "!room:example.org",
        createMatrixReactionEvent({
          eventId: "$owner-reaction",
          targetEventId: "$msg1",
          key: "👍",
        }),
      );

      expect(peekSystemEventEntries("agent:research:global")).toEqual([
        expect.objectContaining({ text: "Matrix reaction added: 👍 by sender on msg $msg1" }),
      ]);
      expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
      expect(binding.targetSessionKey).toBe("global");
      expect(recordedTurn).not.toHaveBeenCalled();
      expect(resolvedTurn).not.toHaveBeenCalled();
    }),
  );

  it(
    "rejects an already-running reaction after its runtime is revoked",
    matrixFixture.wrapCase(async () => {
      const cfg = { channels: { matrix: { dm: { allowFrom: ["*"] } } } };
      const builder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntimeMock({ system: { enqueueSystemEvent } }),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "matrix", origin: "bundled" });
      const api = builder.createApi(record, { config: cfg });
      builder.registry.plugins.push(record);
      const targetLookup = createDeferred<void>();
      const target = createDeferred<{ sender: string }>();
      registerMatrixTestRelease(() => target.resolve({ sender: "@bot:example.org" }));
      const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() };
      const { handler } = createMatrixHandlerTestHarness({
        cfg,
        runtime,
        system: api.runtime.system,
        client: {
          getEvent: async () => {
            targetLookup.resolve();
            return await target.promise;
          },
        },
      });
      const reaction = handler(
        "!room:example.org",
        createMatrixReactionEvent({
          eventId: "$revoked-reaction",
          targetEventId: "$msg1",
          key: "👍",
        }),
      );
      try {
        await waitForMatrixTestSignal(targetLookup.promise, reaction);
        builder.rollbackPluginGlobalSideEffects(record.id, record);
        target.resolve({ sender: "@bot:example.org" });
        await reaction;

        expect(peekSystemEventEntries("agent:ops:main")).toEqual([]);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining('Plugin "matrix" runtime is no longer active'),
        );
      } finally {
        target.resolve({ sender: "@bot:example.org" });
        await reaction;
        await disposePluginRegistryInstances(builder.registry);
      }
    }),
  );
});
