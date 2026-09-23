import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { FailoverError } from "../../agents/failover-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { resolveGatewayAuthPolicyGeneration } from "../auth-policy.js";
import { publishOperatorRoleConfigChange } from "../operator-role-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import * as sessionCreator from "../session-create-service.js";
import type { CreatedGatewaySession } from "../session-create-service.types.js";
import { dispatchInboundMessageMock, installGatewayTestHooks, testState } from "../test-helpers.js";
import { sessionCreateHandlers } from "./sessions-create.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => clearRuntimeConfigSnapshot());

describe("sessions.create initial-turn model policy through authenticated ingress", () => {
  it.each([false, true])(
    "keeps the original ceiling across live widening (primary fails=%s)",
    async (failPrimary) => {
      const storePath = path.join(
        temporaryDirs.make("openclaw-create-model-policy-"),
        "sessions.json",
      );
      testState.sessionStorePath = storePath;
      const key = "agent:main:dashboard:model-policy";
      const profile = ensureProfileForEmail("create-model-policy@example.test");
      const initialConfig = getRuntimeConfig();
      const fixtureModels = ["model-a", "model-b"].map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      }));
      let committedConfig: OpenClawConfig = {
        ...initialConfig,
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: fixtureModels,
            },
          },
        },
        session: { ...initialConfig.session, store: storePath },
        agents: {
          ...initialConfig.agents,
          defaults: {
            ...initialConfig.agents?.defaults,
            model: { primary: "fixture/model-a", fallbacks: ["fixture/model-b"] },
          },
        },
        gateway: {
          ...initialConfig.gateway,
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.write"],
                modelPolicy: { allow: ["fixture/model-a"] },
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(committedConfig);
      const client = createOperatorWsClient({ scopes: ["operator.write"] });
      client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: null,
        avatarRevision: "fixture-avatar",
        hasAvatar: false,
        updatedAt: 1,
      };
      client.internal = { operatorRoleActor: { kind: "operator", profileId: profile.id } };
      client.authPolicyGeneration = resolveGatewayAuthPolicyGeneration(committedConfig);
      const originalGeneration = client.authPolicyGeneration;
      const context = createDirectChatContext({
        getRuntimeConfig: () => committedConfig,
        getCommittedRuntimeConfig: () => committedConfig,
        loadGatewayModelCatalog: async () =>
          fixtureModels.map((model) => ({ ...model, provider: "fixture" })),
      });
      context.resolveGatewayContext = () => context;
      context.readPreparedGatewayModelCatalog = async () => {
        const catalog = await context.loadGatewayModelCatalogSnapshot();
        return { entries: catalog.entries, routeVariants: catalog.routeVariants };
      };
      const harness = createDispatchTestHarness({
        buildRequestContext: () => context,
        extraHandlers: sessionCreateHandlers,
      });
      harness.clients.add(client);
      context.getClientConnIds = (filter) => {
        const connectionIds = new Set<string>();
        for (const current of harness.clients) {
          if (current.connId && !current.invalidated && (!filter || filter(current))) {
            connectionIds.add(current.connId);
          }
        }
        return connectionIds;
      };
      const beforeInitialSend = createDeferred();
      const releaseInitialSend = createDeferred();
      const childEntered = createDeferred();
      const releaseChild = createDeferred();
      let originalAuthority: AdmittedRunOperatorAuthority | undefined;
      let committedSession: CreatedGatewaySession | undefined;
      const createGatewaySession = sessionCreator.createGatewaySession;
      const creator = vi
        .spyOn(sessionCreator, "createGatewaySession")
        .mockImplementation((params) =>
          createGatewaySession({
            ...params,
            afterCreate: async (session) => {
              if (session.key === key) {
                originalAuthority = params.operatorAuthority;
                committedSession = session;
                beforeInitialSend.resolve();
                await releaseInitialSend.promise;
              }
              await params.afterCreate?.(session);
            },
          }),
        );
      const sources: AdmittedRunOperatorAuthority[] = [];
      const callbackWork: Promise<unknown>[] = [];
      const childReleases: Promise<void>[] = [];
      const effects = vi.fn<(model: string) => void>();
      dispatchInboundMessageMock.mockImplementation((input: unknown) => {
        const { replyOptions } = input as Parameters<typeof dispatchInboundMessage>[0];
        const first = sources.length === 0;
        const work = (async () => {
          const source = expectDefined(replyOptions?.operatorAuthority, "admitted child authority");
          sources.push(source);
          if (first) {
            childEntered.resolve();
          }
          const session = expectDefined(committedSession, "committed creation identity");
          const entry = expectDefined(
            loadSessionEntry({
              sessionKey: session.key,
              agentId: session.agentId,
              storePath: session.storePath,
            }),
            "committed child session",
          );
          expect(entry.sessionId).toBe(session.entry.sessionId);
          childReleases.push(
            expectDefined(
              getSessionWorkAdmissionRelease({
                scope: session.storePath,
                identities: [session.key, entry.sessionId],
              }),
              "active child admission",
            ),
          );
          if (first) {
            await releaseChild.promise;
          }
          const recorder = expectDefined(
            replyOptions?.userTurnTranscriptRecorder,
            "durable child input",
          );
          expect(await recorder.persistApproved()).toBeDefined();
          // Exercise the canonical fallback owner at its deterministic provider boundary.
          // This is ingress/authority proof, not a network transport fixture.
          const completion = runWithModelFallback({
            cfg: committedConfig,
            provider: "fixture",
            model: "model-a",
            manifestPlugins: [],
            skipAuthProfileRuntime: true,
            operatorAuthority: source,
            run: async (_provider, model) => {
              effects(model);
              if (model === "model-a" && failPrimary) {
                throw new FailoverError("fixture primary exhausted", { reason: "rate_limit" });
              }
              return model;
            },
          });
          if (first && failPrimary) {
            await expect(completion).rejects.toThrow("fixture primary exhausted");
          } else {
            expect((await completion).result).toBe(failPrimary ? "model-b" : "model-a");
          }
          return {};
        })();
        callbackWork.push(work);
        return work;
      });
      const owner = new AsyncWorkScope();
      const creation = owner.run(() =>
        harness.dispatcher.dispatch(
          {
            type: "req",
            id: "create",
            method: "sessions.create",
            params: { key, displayName: "Model policy fixture", message: "Initial request" },
          },
          client,
        ),
      );
      try {
        await Promise.race([
          beforeInitialSend.promise,
          creation.then(async () => {
            const response = await harness.awaitResponseFrame("create");
            throw new Error(
              `Creation ended before the real post-commit barrier: ${JSON.stringify(response)}`,
            );
          }),
        ]);
        const original = expectDefined(originalAuthority, "pre-await creation authority");
        expect(original.modelPolicy?.allows({ provider: "fixture", model: "model-b" })).toBe(false);
        committedConfig = structuredClone(committedConfig);
        const role = expectDefined(
          committedConfig.gateway?.roles?.definitions.guest,
          "guest policy",
        );
        role.modelPolicy = { allow: ["fixture/model-a", "fixture/model-b"] };
        setRuntimeConfigSnapshot(committedConfig);
        publishOperatorRoleConfigChange(context);
        expect(resolveGatewayAuthPolicyGeneration(committedConfig)).toBe(originalGeneration);
        expect(client.invalidated).not.toBe(true);
        expect(original.signal?.aborted).not.toBe(true);
        expect(() => original.assertCurrent()).not.toThrow();
        expect(original.modelPolicy?.allows({ provider: "fixture", model: "model-b" })).toBe(false);
        releaseInitialSend.resolve();
        const accepted = await harness.awaitResponseFrame("create");
        expect(accepted.ok).toBe(true);
        const committed = expectDefined(committedSession, "acknowledged creation identity");
        expect(accepted.payload).toMatchObject({
          runStarted: true,
          key: committed.key,
          sessionId: committed.entry.sessionId,
        });
        await creation;
        await childEntered.promise;
        const child = expectDefined(sources[0], "retained initial child");
        expect(child.source).toBe(original.source);
        expect(child.modelPolicy?.allows({ provider: "fixture", model: "model-b" })).toBe(false);
        // The parent has returned. No test-owned retain keeps this child current.
        expect(() => child.assertCurrent()).not.toThrow();
        expect(client.internal).not.toHaveProperty("operatorRunAuthority");
        expect(effects).not.toHaveBeenCalled();
        const childReleased = expectDefined(childReleases[0], "held initial child admission");
        releaseChild.resolve();
        await Promise.all(callbackWork);
        await childReleased;
        // Title and provider cleanup can outlive session admission. Observe their natural
        // completion without closing the work owner and aborting the source under test.
        await AsyncWorkScope.runWhenAllIdle(
          () => [owner],
          () => {
            expect(owner.signal.aborted).toBe(false);
            expect(child.signal?.aborted).toBe(false);
            expect(effects.mock.calls).toEqual([["model-a"]]);
            expect(() => child.assertCurrent()).toThrow();
          },
        );

        await owner.run(() =>
          harness.dispatcher.dispatch(
            {
              type: "req",
              id: "fresh",
              method: "chat.send",
              params: {
                sessionKey: committed.key,
                agentId: committed.agentId,
                message: "Fresh request",
                idempotencyKey: "fresh-model-policy",
              },
            },
            client,
          ),
        );
        const fresh = await harness.awaitResponseFrame("fresh");
        expect(fresh.ok).toBe(true);
        expect(isRecord(fresh.payload) && fresh.payload.status).toBe("started");
        await Promise.all(callbackWork);
        await expectDefined(childReleases[1], "fresh child admission");
        await AsyncWorkScope.runWhenAllIdle(
          () => [owner],
          () => {
            expect(owner.signal.aborted).toBe(false);
            expect(sources).toHaveLength(2);
            expect(sources[1]?.modelPolicy?.allows({ provider: "fixture", model: "model-b" })).toBe(
              true,
            );
            expect(effects.mock.calls).toEqual(
              failPrimary ? [["model-a"], ["model-a"], ["model-b"]] : [["model-a"], ["model-a"]],
            );
            expect(harness.close).not.toHaveBeenCalled();
          },
        );
      } finally {
        releaseInitialSend.resolve();
        releaseChild.resolve();
        try {
          await Promise.allSettled([creation, ...callbackWork]);
          await Promise.all(childReleases);
          await AsyncWorkScope.runWhenAllIdle(
            () => [owner],
            () => owner.drain(),
          );
        } finally {
          harness.clients.delete(client);
          creator.mockRestore();
          dispatchInboundMessageMock.mockReset();
        }
      }
    },
  );
});
