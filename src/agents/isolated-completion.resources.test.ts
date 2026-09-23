import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  drainSystemEventsFromSdk,
  peekSystemEventsFromSdk,
} from "../plugins/runtime/system-events.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { runIsolatedCompletion } from "./isolated-completion.js";
import { runWithOperatorModelRequest } from "./operator-model-policy.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { ModelRegistry } from "./sessions/model-registry.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

it.for(["overlap", "callback-tail", "cancel-tail", "auth-tail", "auth-failure"] as const)(
  "retains standalone isolated completion resources through %s",
  async (mode, testContext) => {
    if (mode === "cancel-tail" && process.versions.bun) {
      // Restore this probe when transformed Fetch bodies forward cancellation under Bun.
      testContext.skip();
    }
    const roots = createSyncSuiteTempRootTracker("isolated-completion-resources");
    const root = fs.realpathSync(roots.makeTempDir());
    const providerDir = path.join(root, "provider");
    fs.mkdirSync(providerDir);
    const fixture = createColdPluginFixture({
      rootDir: providerDir,
      pluginId: "isolated-resource-fixture",
      providerId: "isolated-resource-provider",
    });
    const workStarted = createDeferred();
    const finishWork = createDeferred();
    const actualWork: Promise<unknown>[] = [];
    const authFailure = new Error("fixture runtime auth unavailable");
    const callbackFailure = new Error("fixture response callback failed");
    const cancelFailure = new Error("fixture stream cancellation failed");
    let authCalls = 0;
    let authWorkSignal: AbortSignal | undefined;
    let authWorkFinished = false;
    let normalDrainRegistryMatches: boolean | undefined;
    const globalKey = `__isolatedAuthWork_${path.basename(root)}`;
    Object.defineProperty(globalThis, globalKey, {
      configurable: true,
      value: () => {
        if (++authCalls !== 1) {
          return;
        }
        if (mode === "auth-tail" || mode === "auth-failure") {
          authWorkSignal = getAsyncWorkSignal();
          const selectedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
          authWorkSignal?.addEventListener(
            "abort",
            () => {
              normalDrainRegistryMatches =
                getPluginRuntimeGatewayRequestScope()?.pluginRegistry === selectedRegistry;
            },
            { once: true },
          );
          const pending = trackAsyncWork(async () => {
            workStarted.resolve();
            await finishWork.promise;
            authWorkSignal?.throwIfAborted();
            authWorkFinished = true;
          });
          actualWork.push(pending);
          void pending.catch(() => {});
          if (mode === "auth-failure") {
            throw authFailure;
          }
        }
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({
          id: ${JSON.stringify(fixture.providerId)}, label: "Isolated resources", auth: [],
          async prepareRuntimeAuth() { globalThis[${JSON.stringify(globalKey)}](); }
        });
      } };`,
    );
    const requests: ServerResponse[] = [];
    const arrivals = [createDeferred(), createDeferred(), createDeferred()];
    let finishing = false;
    const finishResponse = (response: ServerResponse, index: number) => {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      writeOpenAiResponsesSse(response, [
        {
          id: "isolated-response",
          object: "chat.completion.chunk",
          model: "isolated-model",
          choices: [{ index: 0, delta: { content: `reply-${index}` }, finish_reason: "stop" }],
        },
      ]);
    };
    const server = createServer((request, response) => {
      request.resume();
      const index = requests.push(response) - 1;
      arrivals[index]?.resolve();
      if (finishing) {
        finishResponse(response, index);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const calls: Promise<unknown>[] = [];
    const spies: Array<{ mockRestore(): void }> = [];
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Isolated completion fixture has no TCP port");
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: root, model: `${fixture.providerId}/isolated-model` } },
        models: {
          providers: {
            [fixture.providerId]: {
              api: "openai-completions",
              apiKey: "synthetic-isolated-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                {
                  id: "isolated-model",
                  name: "Isolated model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      };
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          expect(getAsyncWorkSignal()).toBeUndefined();
          const create = vi.spyOn(ModelRegistry, "create");
          const fork = vi.spyOn(ModelRegistry.prototype, "fork");
          spies.push(create, fork);
          if (mode === "callback-tail" || mode === "cancel-tail") {
            const { configureAiTransportRuntimeHost } =
              await import("./ai-transport-runtime-host.js");
            configureAiTransportRuntimeHost();
            const pluginHost = getAiTransportHost().plugin;
            const wrap = pluginHost.wrapSimpleCompletionStream;
            let responses = 0;
            spies.push(
              vi.spyOn(pluginHost, "wrapSimpleCompletionStream").mockImplementation((params) => {
                const stream = wrap(params) ?? params.context.streamFn;
                return (model, context, options) =>
                  stream(model, context, {
                    ...options,
                    onResponse: async (response, responseModel) => {
                      await options?.onResponse?.(response, responseModel);
                      if (++responses !== 1) {
                        return;
                      }
                      if (mode === "cancel-tail") {
                        throw callbackFailure;
                      }
                      workStarted.resolve();
                      const pending = finishWork.promise;
                      actualWork.push(pending);
                      await pending;
                    },
                  });
              }),
            );
            if (mode === "cancel-tail") {
              const realFetch = globalThis.fetch;
              let wrapped = false;
              spies.push(
                vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
                  const response = await realFetch(...args);
                  if (wrapped || !response.url.startsWith(`http://127.0.0.1:${address.port}/`)) {
                    return response;
                  }
                  wrapped = true;
                  const reader = response.body?.getReader();
                  if (!reader) {
                    throw new Error("Isolated fixture response has no body");
                  }
                  return new Response(
                    new ReadableStream<Uint8Array>({
                      async pull(controller) {
                        const { value, done } = await reader.read();
                        if (done) {
                          controller.close();
                        } else {
                          controller.enqueue(value);
                        }
                      },
                      async cancel(reason) {
                        workStarted.resolve();
                        const pending = (async () => {
                          try {
                            await finishWork.promise;
                            throw cancelFailure;
                          } finally {
                            await reader.cancel(reason);
                          }
                        })();
                        actualWork.push(pending);
                        return await pending;
                      },
                    }),
                    { status: response.status, headers: response.headers },
                  );
                }),
              );
            }
          }
          const start = (signal?: AbortSignal) => {
            const pending = runIsolatedCompletion({
              config: cfg,
              provider: fixture.providerId,
              model: "isolated-model",
              agentId: "main",
              agentHarnessRuntimeOverride: "openclaw",
              systemPrompt: "Return a short reply.",
              prompt: "Fixture input",
              timeoutMs: 10_000,
              abortSignal: signal,
            });
            calls.push(pending);
            return pending;
          };
          const waitForRequest = (index: number, call: Promise<unknown>) =>
            Promise.race([
              arrivals[index]!.promise,
              call.then(() => {
                throw new Error("Completion ended before the expected provider request");
              }),
            ]);
          const abortReason = new Error("fixture isolated caller aborted");
          const controller = new AbortController();
          const first = start(mode === "callback-tail" ? controller.signal : undefined);
          if (mode === "auth-failure") {
            await expect(first).rejects.toBe(authFailure);
            await workStarted.promise;
            expect(requests).toHaveLength(0);
          } else {
            await waitForRequest(0, first);
            if (mode !== "overlap") {
              finishResponse(requests[0]!, 0);
              if (mode === "callback-tail" || mode === "cancel-tail") {
                await Promise.race([
                  workStarted.promise,
                  first.then(() => {
                    throw new Error("Completion ended before its accepted work started");
                  }),
                ]);
              }
              if (mode === "callback-tail") {
                controller.abort(abortReason);
                await expect(first).rejects.toBe(abortReason);
              } else if (mode === "cancel-tail") {
                await expect(first).rejects.toMatchObject({ code: "output-rejected" });
              } else {
                await expect(first).resolves.toMatchObject({ text: "reply-0" });
                await workStarted.promise;
              }
            }
          }
          if (mode === "auth-tail" || mode === "auth-failure") {
            expect.soft(authWorkSignal?.aborted ?? false).toBe(false);
          }
          const firstBuilds = create.mock.calls.length;
          expect(firstBuilds).toBeGreaterThan(0);
          const secondIndex = mode === "auth-failure" ? 0 : 1;
          const second = start();
          await waitForRequest(secondIndex, second);
          expect.soft(create.mock.calls.length).toBe(firstBuilds);
          expect(fork.mock.calls.length).toBe(2);
          expect(fork.mock.calls[0]![0] === fork.mock.calls[1]![0]).toBe(false);
          finishWork.resolve();
          await Promise.allSettled(actualWork);
          if (mode === "auth-tail" || mode === "auth-failure") {
            expect.soft(authWorkFinished).toBe(true);
          }
          if (mode === "overlap") {
            finishResponse(requests[0]!, 0);
            await expect(first).resolves.toMatchObject({ text: "reply-0" });
          }
          finishResponse(requests[secondIndex]!, secondIndex);
          await expect(second).resolves.toMatchObject({ text: `reply-${secondIndex}` });
          const thirdIndex = secondIndex + 1;
          const third = start();
          await waitForRequest(thirdIndex, third);
          expect(create.mock.calls.length).toBe(firstBuilds + 1);
          finishResponse(requests[thirdIndex]!, thirdIndex);
          await expect(third).resolves.toMatchObject({ text: `reply-${thirdIndex}` });
          if (authWorkSignal) {
            expect(normalDrainRegistryMatches).toBe(true);
          }
        },
      );
    } finally {
      finishWork.resolve();
      finishing = true;
      requests.forEach(finishResponse);
      await Promise.allSettled(calls);
      await Promise.allSettled(actualWork);
      for (const spy of spies) {
        spy.mockRestore();
      }
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
      Reflect.deleteProperty(globalThis, globalKey);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      roots.cleanup();
    }
  },
);

it.each(["foreground", "finite-model", "staff", "revoked", "deadline", "cancelled"] as const)(
  "keeps isolated %s authority through a real provider callback and SDK producer",
  async (mode) => {
    const roots = createSyncSuiteTempRootTracker("isolated-foreground-producer");
    const root = fs.realpathSync(roots.makeTempDir());
    const providerDir = path.join(root, "provider");
    fs.mkdirSync(providerDir);
    const fixture = createColdPluginFixture({
      rootDir: providerDir,
      pluginId: "isolated-producer-fixture",
      providerId: "isolated-producer-provider",
    });
    const sessionKey = "agent:main:isolated-provider-event";
    const entered = createDeferred();
    const attemptProducer = createDeferred();
    const attempted = createDeferred();
    const finishCallback = createDeferred();
    const owner = new AsyncWorkScope();
    const source = new AbortController();
    const caller = new AbortController();
    const deadline = Date.now() + 60_000;
    const activeHolds = new Set<object>();
    const holds: Array<{ token: object; release: () => void }> = [];
    let callbackEntered = false;
    let callbackFinished = false;
    let lostAuthorityDuringCallback = false;
    const retain = vi.fn(() => {
      const token = {};
      activeHolds.add(token);
      const release = vi.fn(() => {
        activeHolds.delete(token);
        if (callbackEntered && !callbackFinished && activeHolds.size === 0) {
          lostAuthorityDuringCallback = true;
        }
      });
      holds.push({ token, release });
      return release;
    });
    const allowed = mode === "finite-model" || mode === "staff";
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "isolated-producer-person",
      scopes: ["operator.sessions.write"],
      ...(!allowed
        ? {
            executionPolicy: "foreground-only" as const,
            foregroundRunId: "isolated-turn",
            foregroundDeadlineAt: deadline,
          }
        : {}),
      ...(mode === "finite-model"
        ? { permissions: { models: { allow: [`${fixture.providerId}/isolated-model`] } } }
        : {}),
      signal: source.signal,
      assertCurrent() {},
      retain,
    });
    const callbackWork: Promise<void>[] = [];
    const callback = vi.fn((enqueue: () => boolean) => {
      const work = (async () => {
        callbackEntered = true;
        expect(activeHolds.size).toBeGreaterThan(0);
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
        expect(getPluginRuntimeGatewayRequestScope()?.client ?? null).toBeNull();
        expect(runWithOperatorModelRequest(undefined, (original) => original?.source)).toBe(
          authority.source,
        );
        entered.resolve();
        await attemptProducer.promise;
        const clock =
          mode === "deadline" ? vi.spyOn(Date, "now").mockReturnValue(deadline) : undefined;
        try {
          if (allowed) {
            expect(enqueue()).toBe(true);
          } else {
            expect(enqueue).toThrow(
              mode === "revoked"
                ? /original provider source revoked/
                : mode === "deadline"
                  ? /deadline has expired/
                  : /foreground turn only/,
            );
          }
        } finally {
          clock?.mockRestore();
          attempted.resolve();
          await finishCallback.promise;
          callbackFinished = true;
        }
      })();
      callbackWork.push(work);
      return work;
    });
    const globalKey = `__isolatedProducer_${path.basename(root)}`;
    Object.defineProperty(globalThis, globalKey, { configurable: true, value: callback });
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      requests++;
      writeOpenAiResponsesSse(response, [
        {
          id: "isolated-producer-response",
          object: "chat.completion.chunk",
          model: "isolated-model",
          choices: [{ index: 0, delta: { content: "accepted" }, finish_reason: "stop" }],
        },
      ]);
    });
    const calls: Promise<unknown>[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Isolated producer fixture has no TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      fs.writeFileSync(
        fixture.runtimeSource,
        `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({
          id: ${JSON.stringify(fixture.providerId)}, label: "Isolated producer", auth: [],
          resolveModelRequestBindingSupport({ model, transport }) {
            return model.provider === ${JSON.stringify(fixture.providerId)} && model.id === "isolated-model" &&
              model.api === "openai-completions" && model.baseUrl === ${JSON.stringify(baseUrl)} && transport === "sse"
              ? { wrapSimpleCompletionStreamFn: "preserves-delegate" } : undefined;
          },
          wrapSimpleCompletionStreamFn({ streamFn }) {
            const wrapped = (model, context, options) => streamFn(model, context, { ...options,
              onResponse: async (response, responseModel) => {
                await options?.onResponse?.(response, responseModel);
                await globalThis[${JSON.stringify(globalKey)}](() => api.runtime.system.enqueueSystemEvent("provider callback event", { sessionKey: ${JSON.stringify(sessionKey)} }));
              }
            });
            return Object.assign(wrapped, { modelRequestBinding: streamFn.modelRequestBinding });
          }
        });
      } };`,
      );
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: root,
            model: `${fixture.providerId}/isolated-model`,
            models: { [`${fixture.providerId}/isolated-model`]: { params: { transport: "sse" } } },
          },
        },
        models: {
          providers: {
            [fixture.providerId]: {
              api: "openai-completions",
              apiKey: "synthetic-isolated-key",
              baseUrl,
              models: [
                {
                  id: "isolated-model",
                  name: "Isolated model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      };
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          expect(peekSystemEventsFromSdk(sessionKey)).toEqual([]);
          const pending = owner.run(() =>
            runIsolatedCompletion({
              config,
              operatorAuthority: authority,
              provider: fixture.providerId,
              model: "isolated-model",
              agentId: "main",
              agentHarnessRuntimeOverride: "openclaw",
              systemPrompt: "Return a short reply.",
              prompt: "Fixture input",
              timeoutMs: 10_000,
              abortSignal: caller.signal,
            }),
          );
          calls.push(pending);
          const cancellation = new Error("isolated caller stopped");
          const checked =
            mode === "cancelled"
              ? expect(pending).rejects.toBe(cancellation)
              : mode === "revoked" || mode === "deadline"
                ? expect(pending).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" })
                : expect(pending).resolves.toMatchObject({
                    text: "accepted",
                    owner: { kind: "harness", id: "openclaw" },
                  });
          calls.push(checked);
          try {
            await Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("Completion missed its provider callback");
              }),
            ]);
            expect(requests).toBe(1);
            expect(callback).toHaveBeenCalledOnce();
            expect(retain.mock.calls.length).toBeGreaterThan(0);
            expect(activeHolds.size).toBeGreaterThan(0);
            expect(lostAuthorityDuringCallback).toBe(false);
            if (mode === "revoked") {
              source.abort(new Error("original provider source revoked"));
            }
            if (mode === "cancelled") {
              caller.abort(cancellation);
              await checked;
              expect(callbackFinished).toBe(false);
              expect(activeHolds.size).toBeGreaterThan(0);
              expect(lostAuthorityDuringCallback).toBe(false);
            }
            attemptProducer.resolve();
            await Promise.race([attempted.promise, Promise.all(callbackWork)]);
            expect(peekSystemEventsFromSdk(sessionKey)).toEqual(
              allowed ? ["provider callback event"] : [],
            );
            expect(callbackFinished).toBe(false);
            expect(activeHolds.size).toBeGreaterThan(0);
            expect(lostAuthorityDuringCallback).toBe(false);
            finishCallback.resolve();
            await Promise.all(callbackWork);
            await checked;
            await owner.drain();
            expect(callbackFinished).toBe(true);
            expect(lostAuthorityDuringCallback).toBe(false);
            expect(activeHolds.size).toBe(0);
            expect(holds).toHaveLength(retain.mock.calls.length);
            for (const hold of holds) {
              expect(hold.release).toHaveBeenCalledOnce();
            }
            expect(requests).toBe(1);
          } finally {
            caller.abort(cancellation);
            attemptProducer.resolve();
            finishCallback.resolve();
            await Promise.allSettled(calls);
            await Promise.allSettled(callbackWork);
            await owner.drain();
            drainSystemEventsFromSdk(sessionKey);
          }
        },
      );
    } finally {
      caller.abort();
      attemptProducer.resolve();
      finishCallback.resolve();
      await Promise.allSettled(calls);
      await Promise.allSettled(callbackWork);
      await owner.drain();
      await resetPreparedModelRuntimeSnapshotsForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      clearPluginMetadataLifecycleCaches();
      resetPluginLoaderTestStateForTest();
      Reflect.deleteProperty(globalThis, globalKey);
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      roots.cleanup();
    }
  },
);
