import { createServer } from "node:http";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { responsesRequestLifecycle } from "@openclaw/ai/internal/openai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import {
  createOpenClawTransportStreamFnForModel,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import type { StreamOptions } from "@openclaw/llm-core";
import { expectDefined } from "@openclaw/normalization-core";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableAssistantError } from "../llm/utils/retry.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import { resolveEmbeddedAgentStream } from "./embedded-agent-runner/stream-resolution.js";
import {
  prepareOperatorModelPolicy,
  runWithOperatorModelRequest,
  wrapOperatorModelStream,
} from "./operator-model-policy.js";
import {
  attachModelProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("operator model authority at real Completions dispatch", { concurrent: false }, () => {
  const requests: Array<{ method: string; path: string; payload: unknown }> = [];
  let healthGate:
    | {
        entered: Deferred;
        release: Deferred;
      }
    | undefined;
  let healthReads = 0;
  let rejectNextResponse = false;
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      healthReads++;
      healthGate?.entered.resolve();
      void (healthGate?.release.promise ?? Promise.resolve()).then(() => response.end("healthy"));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload: unknown = JSON.parse(body);
      requests.push({ method: request.method ?? "", path: request.url ?? "", payload });
      if (new URL(request.url ?? "/", "http://localhost").pathname.endsWith("/responses")) {
        if (rejectNextResponse) {
          rejectNextResponse = false;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { code: "invalid_encrypted_content", message: "invalid checkpoint" },
            }),
          );
          return;
        }
        const result = {
          id: "resp_loopback",
          object: "response",
          status: "completed",
          model: asNonArrayRecord(payload).model,
          output: [
            {
              id: "msg_loopback",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "accepted", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            {
              type: "response.created",
              response: { ...result, output: [], status: "in_progress" },
            },
            { type: "response.completed", response: result },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "loopback-completion",
          object: "chat.completion.chunk",
          created: 1,
          model: asNonArrayRecord(payload).model,
          choices: [
            { index: 0, delta: { role: "assistant", content: "accepted" }, finish_reason: "stop" },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  let model: ReturnType<typeof makeProviderModelFixture>;

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Model authority fixture did not expose its loopback port");
    }
    const transportModel = attachModelProviderRequestTransport(
      makeProviderModelFixture({
        api: "openai-completions",
        provider: "model-policy-loopback",
        id: "allowed",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      }),
      { allowPrivateNetwork: true },
    );
    model = attachModelProviderRuntimePluginHandle(transportModel, {
      provider: transportModel.provider,
      modelId: transportModel.id,
      plugin: {
        id: transportModel.provider,
        label: "Loopback model authority fixture",
        auth: [],
        resolveModelRequestBindingSupport: ({ model: selected, transport }) =>
          selected.provider === transportModel.provider &&
          selected.id === transportModel.id &&
          selected.api === transportModel.api &&
          selected.baseUrl === transportModel.baseUrl &&
          transport === "sse"
            ? { createStreamFn: "wire-model-v1" }
            : undefined,
        // Register the real transport before any caller enters its authority scope.
        createStreamFn: () => createOpenClawTransportStreamFnForModel(transportModel),
      },
    });
    expectDefined(
      registerProviderStreamForModel({ model, apiRegistry: registry, preparedTransport: "sse" }),
      "registered real Completions transport",
    );
  });

  beforeEach(() => {
    requests.length = 0;
    healthReads = 0;
    healthGate = undefined;
    rejectNextResponse = false;
  });

  afterAll(async () => {
    registry.clearApiProviders();
    try {
      await stopManagedProviderLocalServices();
      await closeProviderTransportDispatcherPool();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["openai-completions", "openai-responses"] as const)(
    "keeps managed %s aliases qualified across staff-first and finite-first preparation",
    async (api) => {
      for (const firstFinite of [false, true]) {
        for (const staffTransport of [undefined, "auto"] as const) {
          const selected = attachModelProviderRequestTransport(
            makeProviderModelFixture({
              provider: model.provider,
              id: model.id,
              api,
              baseUrl: model.baseUrl,
            }),
            { allowPrivateNetwork: true, tls: {} },
          );
          const bound = attachModelProviderRuntimePluginHandle(selected, {
            provider: selected.provider,
            modelId: selected.id,
            plugin: {
              id: selected.provider,
              label: "Transparent fixture",
              auth: [],
              wrapSimpleCompletionStreamFn: ({ streamFn }) => streamFn,
              resolveModelRequestBindingSupport: ({ model: route, transport }) =>
                route.provider === selected.provider &&
                route.id === selected.id &&
                route.api === api &&
                route.baseUrl === selected.baseUrl &&
                transport === "sse"
                  ? { wrapSimpleCompletionStreamFn: "preserves-delegate" }
                  : undefined,
            },
          });
          const apiRegistry = createApiRegistry();
          registerBuiltInApiProviders(apiRegistry);
          const localRuntime = createLlmRuntime(apiRegistry);
          const authority = createAdmittedRunOperatorAuthority({
            profileId: "finite-operator",
            scopes: ["operator.sessions.write"],
            modelPolicy: prepareOperatorModelPolicy({
              cfg: {},
              policy: { allow: [`${selected.provider}/${selected.id}`] },
              manifestPlugins: [],
            }),
            assertCurrent() {},
          });
          const prepare = (finite: boolean) =>
            runWithOperatorModelRequest(finite ? authority : undefined, () =>
              prepareModelForSimpleCompletion({
                model: bound,
                apiRegistry,
                transport: finite ? "sse" : staffTransport,
              }),
            );
          try {
            const first = prepare(firstFinite);
            const firstProviders = apiRegistry.getApiProviders();
            const second = prepare(!firstFinite);
            expect(second.api).toBe(first.api);
            expect(first.api).toMatch(/^openclaw-provider-simple:/);
            expect(apiRegistry.getApiProviders()).toEqual(firstProviders);
            for (const registration of firstProviders) {
              expect(apiRegistry.getApiProvider(registration.api)).toBe(registration);
            }
            const before = requests.length;
            for (const finite of [true, false]) {
              const message = await runWithOperatorModelRequest(
                finite ? authority : undefined,
                () =>
                  localRuntime.completeSimple(
                    second,
                    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
                    { apiKey: "loopback-test-key", transport: "sse" },
                  ),
              );
              expect(message, JSON.stringify(message)).toMatchObject({
                stopReason: "stop",
                content: [{ type: "text", text: "accepted" }],
              });
            }
            expect(requests).toHaveLength(before + 2);
            expect(
              requests.slice(before).map((request) => asNonArrayRecord(request.payload).model),
            ).toEqual(["allowed", "allowed"]);
            for (const transport of [undefined, "auto", "websocket"] as const) {
              expect(() =>
                runWithOperatorModelRequest(authority, () =>
                  prepareModelForSimpleCompletion({ model: bound, apiRegistry, transport }),
                ),
              ).toThrow(/cannot enforce/);
            }
            expect(requests).toHaveLength(before + 2);
          } finally {
            apiRegistry.clearApiProviders();
          }
        }
      }
    },
  );

  it.each([
    "allowed",
    "payload-model-rewrite",
    "source-revoked",
    "in-place-model",
    "model-argument",
    "model-getter",
    "custom-json",
  ] as const)("%s after awaited payload preparation", async (mode) => {
    let current = true;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "loopback-operator",
      scopes: ["operator.sessions.write"],
      modelPolicy: prepareOperatorModelPolicy({
        cfg: {},
        policy: { allow: ["model-policy-loopback/allowed"] },
        manifestPlugins: [],
      }),
      assertCurrent: () => {
        if (!current) {
          throw new Error("Original model authority was revoked during payload preparation");
        }
      },
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const eventTypes: string[] = [];
    let originalPayload: unknown;
    const provider = expectDefined(registry.getApiProvider(model.api), "registered API owner");
    const { streamFn } = resolveEmbeddedAgentStream({
      llmRuntime: runtime,
      currentStreamFn: runtime.streamSimple,
      providerStreamFn: provider.stream,
      model,
      sessionId: `loopback-${mode}`,
      operatorAuthority: authority,
    });
    const result = (async () => {
      const stream = await streamFn(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        {
          apiKey: "loopback-test-key", // pragma: allowlist secret
          transport: "sse",
          signal: controller.signal,
          onPayload: async (payload, hookModel) => {
            // Capture the JSON wire shape, including values omitted during serialization.
            const serializedPayload = JSON.stringify(payload);
            originalPayload = JSON.parse(serializedPayload);
            entered.resolve();
            await release.promise;
            if (mode === "payload-model-rewrite") {
              return { ...asNonArrayRecord(payload), model: "forbidden" };
            }
            if (mode === "in-place-model") {
              asNonArrayRecord(payload).model = "forbidden";
            } else if (mode === "model-argument") {
              hookModel.id = "forbidden";
            } else if (mode === "model-getter") {
              Object.defineProperty(payload, "model", { get: () => "allowed" });
            } else if (mode === "custom-json") {
              Object.assign(asNonArrayRecord(payload), { toJSON: () => ({ model: "forbidden" }) });
            }
            return undefined;
          },
        },
      );
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      return await stream.result();
    })();
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error("Transport settled before its payload preparation gate");
        }),
      ]);
      expect(requests).toEqual([]);
      expect(asNonArrayRecord(originalPayload).model).toBe("allowed");
      if (mode === "source-revoked") {
        current = false;
      }
      release.resolve();
      const message = await result;
      if (mode === "allowed") {
        expect(message).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "accepted" }],
        });
        expect(eventTypes).toContain("done");
        expect(eventTypes).not.toContain("error");
        expect(requests).toEqual([
          { method: "POST", path: "/v1/chat/completions", payload: originalPayload },
        ]);
      } else {
        expect.soft(message).toMatchObject({
          stopReason: "error",
          errorCode: "OPERATOR_MODEL_POLICY_DENIED",
        });
        expect.soft(eventTypes).toContain("error");
        expect.soft(requests).toEqual([]);
        expect(model.id).toBe("allowed");
      }
    } finally {
      release.resolve();
      controller.abort();
      await Promise.allSettled([result]);
    }
  });

  it.each(["already-revoked", "late-revocation", "borrowed-payload"] as const)(
    "retains the binding through real SDK and local readiness: %s",
    async (mode) => {
      let current = mode !== "already-revoked";
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "readiness-operator",
        scopes: ["operator.sessions.write"],
        modelPolicy: prepareOperatorModelPolicy({
          cfg: {},
          policy: { allow: ["model-policy-loopback/allowed"] },
          manifestPlugins: [],
        }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("original source revoked");
          }
        },
      });
      const gate = { entered: createDeferredCore(), release: createDeferredCore() };
      healthGate = gate;
      const localModel = attachModelProviderLocalService(model, {
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        healthUrl: new URL("/health", model.baseUrl).toString(),
      });
      const transport = expectDefined(
        createOpenClawTransportStreamFnForModel(localModel),
        "real transport",
      );
      let borrowed: unknown;
      const result = (async () => {
        const stream = await wrapOperatorModelStream(transport, authority)(
          localModel,
          { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
          {
            apiKey: "loopback-test-key",
            transport: "sse",
            onPayload: (payload) => {
              borrowed = payload;
            },
          },
        );
        for await (const event of stream) {
          /* Drain the real stream and response body. */
          void event;
        }
        return stream.result();
      })();
      try {
        if (mode === "already-revoked") {
          await expect(result).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
          expect(healthReads).toBe(0);
        } else {
          await Promise.race([
            gate.entered.promise,
            result.then(() => {
              throw new Error("request missed readiness gate");
            }),
          ]);
          expect(requests).toEqual([]);
          if (mode === "late-revocation") {
            current = false;
          } else {
            asNonArrayRecord(borrowed).model = "forbidden";
          }
          gate.release.resolve();
          const message = await result;
          if (mode === "late-revocation") {
            expect(message).toMatchObject({
              stopReason: "error",
              errorCode: "OPERATOR_MODEL_POLICY_DENIED",
            });
            expect(isRetryableAssistantError(message)).toBe(false);
          } else {
            expect(message.stopReason).toBe("stop");
            expect(requests).toHaveLength(1);
            expect(asNonArrayRecord(requests[0]?.payload).model).toBe("allowed");
          }
        }
        if (mode !== "borrowed-payload") {
          expect(requests).toEqual([]);
        }
      } finally {
        gate.release.resolve();
        await Promise.allSettled([result]);
        await stopManagedProviderLocalServices();
      }
    },
  );

  it.each(["allowed", "mapped-wire", "rewrite", "revoked"] as const)(
    "binds real Responses HTTP selection: %s",
    async (mode) => {
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "responses-operator",
        scopes: ["operator.sessions.write"],
        modelPolicy: prepareOperatorModelPolicy({
          cfg: {},
          policy: { allow: ["model-policy-loopback/allowed"] },
          manifestPlugins: [],
        }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("responses source revoked");
          }
        },
      });
      const responseModel = attachModelProviderRequestTransport(
        { ...model, api: mode === "mapped-wire" ? "azure-openai-responses" : "openai-responses" },
        { allowPrivateNetwork: true },
      );
      const transport = expectDefined(
        createOpenClawTransportStreamFnForModel(responseModel),
        "Responses transport",
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      if (mode === "mapped-wire") {
        vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "allowed=deployment-alias");
      }
      const result = (async () => {
        const stream = await wrapOperatorModelStream(transport, authority)(
          responseModel,
          { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
          {
            apiKey: "loopback-test-key",
            transport: "sse",
            onPayload: async (payload) => {
              entered.resolve();
              await release.promise;
              if (mode === "rewrite") {
                return { ...asNonArrayRecord(payload), model: "forbidden" };
              }
              return undefined;
            },
          },
        );
        for await (const event of stream) {
          /* Join transport consumption. */
          void event;
        }
        return stream.result();
      })();
      try {
        await Promise.race([
          entered.promise,
          result.then(() => {
            throw new Error("Responses missed payload gate");
          }),
        ]);
        expect(requests).toEqual([]);
        if (mode === "revoked") {
          current = false;
        }
        release.resolve();
        const message = await result;
        if (mode === "allowed" || mode === "mapped-wire") {
          expect(message, JSON.stringify(message)).toMatchObject({ stopReason: "stop" });
          expect(requests).toHaveLength(1);
          if (mode === "mapped-wire") {
            expect(
              new URL(requests[0]!.path, "http://localhost").searchParams.get("api-version"),
            ).toBe("preview");
          }
          expect(asNonArrayRecord(requests[0]?.payload).model).toBe(
            mode === "mapped-wire" ? "deployment-alias" : "allowed",
          );
        } else {
          expect(message).toMatchObject({
            stopReason: "error",
            errorCode: "OPERATOR_MODEL_POLICY_DENIED",
          });
          expect(requests).toEqual([]);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([result]);
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["openai-completions", "openai-responses", "azure-openai-responses"] as const)(
    "binds the actual lazy raw %s provider",
    async (api) => {
      const rawRegistry = createApiRegistry();
      registerBuiltInApiProviders(rawRegistry);
      const rawRuntime = createLlmRuntime(rawRegistry);
      const selected = attachModelProviderRequestTransport(
        { ...model, api },
        { allowPrivateNetwork: true },
      );
      try {
        for (const mode of ["allowed", "rewrite", "revoked", "unrestricted"] as const) {
          requests.length = 0;
          let current = true;
          const authority = createAdmittedRunOperatorAuthority({
            profileId: "direct-operator",
            scopes: ["operator.sessions.write"],
            modelPolicy: prepareOperatorModelPolicy({
              cfg: {},
              policy: { allow: ["model-policy-loopback/allowed"] },
              manifestPlugins: [],
            }),
            assertCurrent: () => {
              if (!current) {
                throw new Error("direct source revoked");
              }
            },
          });
          const stream = runWithOperatorModelRequest(
            mode === "unrestricted" ? undefined : authority,
            () =>
              rawRuntime.stream(
                selected,
                { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
                {
                  apiKey: "loopback-test-key",
                  transport: "sse",
                  onPayload: async (payload) => {
                    await Promise.resolve();
                    if (mode === "revoked") {
                      current = false;
                    }
                    if (mode === "rewrite" || mode === "unrestricted") {
                      return { ...asNonArrayRecord(payload), model: "forbidden" };
                    }
                    return undefined;
                  },
                },
              ),
          );
          for await (const event of stream) {
            /* Join the installed provider and SDK response. */
            void event;
          }
          const message = await stream.result();
          if (mode === "rewrite" || mode === "revoked") {
            expect(message).toMatchObject({
              stopReason: "error",
              errorCode: "OPERATOR_MODEL_POLICY_DENIED",
            });
            expect(isRetryableAssistantError(message)).toBe(false);
            expect(requests).toEqual([]);
          } else {
            expect(message, JSON.stringify(message)).toMatchObject({ stopReason: "stop" });
            expect(requests).toHaveLength(1);
            expect(asNonArrayRecord(requests[0]?.payload).model).toBe(
              mode === "allowed" ? "allowed" : "forbidden",
            );
          }
        }
      } finally {
        rawRegistry.clearApiProviders();
      }
    },
  );

  it.each(["allowed", "rewrite", "revoked"] as const)(
    "retains Responses authority during real checkpoint replay: %s",
    async (mode) => {
      let current = true;
      let preparations = 0;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "replay-operator",
        scopes: ["operator.sessions.write"],
        modelPolicy: prepareOperatorModelPolicy({
          cfg: {},
          policy: { allow: ["model-policy-loopback/allowed"] },
          manifestPlugins: [],
        }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("replay source revoked");
          }
        },
      });
      const selected = attachModelProviderRequestTransport(
        { ...model, api: "openai-responses" },
        { allowPrivateNetwork: true },
      );
      const transport = expectDefined(
        createOpenClawTransportStreamFnForModel(selected),
        "Responses transport",
      );
      rejectNextResponse = true;
      const stream = await wrapOperatorModelStream(transport, authority)(
        selected,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        {
          apiKey: "loopback-test-key",
          transport: "sse",
          onPayload: async (payload) => {
            await Promise.resolve();
            preparations++;
            const params = asNonArrayRecord(payload);
            if (preparations === 1) {
              return {
                ...params,
                input: [{ type: "compaction", encrypted_content: "fixture-checkpoint" }],
              };
            }
            if (mode === "revoked") {
              current = false;
            }
            if (mode === "rewrite") {
              return { ...params, model: "forbidden" };
            }
            return undefined;
          },
        },
      );
      for await (const event of stream) {
        /* Join replay and any terminal response. */
        void event;
      }
      const message = await stream.result();
      expect(preparations).toBe(2);
      expect(asNonArrayRecord(requests[0]?.payload).model).toBe("allowed");
      if (mode === "allowed") {
        expect(message, JSON.stringify(message)).toMatchObject({ stopReason: "stop" });
        expect(requests).toHaveLength(2);
        expect(asNonArrayRecord(requests[1]?.payload).model).toBe("allowed");
        expect(asNonArrayRecord(requests[1]?.payload).input).not.toContainEqual(
          expect.objectContaining({ type: "compaction" }),
        );
      } else {
        expect(message).toMatchObject({
          stopReason: "error",
          errorCode: "OPERATOR_MODEL_POLICY_DENIED",
        });
        expect(isRetryableAssistantError(message)).toBe(false);
        expect(requests).toHaveLength(1);
      }
    },
  );

  it.each(["allowed", "revoked"] as const)(
    "composes the held Responses publication lifecycle: %s",
    async (mode) => {
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "publication-operator",
        scopes: ["operator.sessions.write"],
        modelPolicy: prepareOperatorModelPolicy({
          cfg: {},
          policy: { allow: ["model-policy-loopback/allowed"] },
          manifestPlugins: [],
        }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("publication source revoked");
          }
        },
      });
      const selected = attachModelProviderRequestTransport(
        { ...model, api: "openai-responses" },
        { allowPrivateNetwork: true },
      );
      const transport = expectDefined(
        createOpenClawTransportStreamFnForModel(selected),
        "Responses transport",
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const accepted = vi.fn();
      const settled = vi.fn();
      const options: StreamOptions = { apiKey: "loopback-test-key", transport: "sse" };
      responsesRequestLifecycle.set(options, {
        beforeDispatch: async () => {
          entered.resolve();
          await release.promise;
        },
        assertCurrent: () => {},
        accepted: async (id) => {
          accepted(id);
        },
        settle: async () => {
          settled();
        },
      });
      const result = (async () => {
        const stream = await wrapOperatorModelStream(transport, authority)(
          selected,
          { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
          options,
        );
        for await (const event of stream) {
          /* Join lifecycle acceptance and transport cleanup. */
          void event;
        }
        return stream.result();
      })();
      try {
        await Promise.race([
          entered.promise,
          result.then(() => {
            throw new Error("request missed publication gate");
          }),
        ]);
        expect(requests).toEqual([]);
        expect(accepted).not.toHaveBeenCalled();
        if (mode === "revoked") {
          current = false;
        }
        release.resolve();
        const message = await result;
        if (mode === "allowed") {
          expect(message, JSON.stringify(message)).toMatchObject({ stopReason: "stop" });
          expect(requests).toHaveLength(1);
          expect(accepted).toHaveBeenCalledExactlyOnceWith("resp_loopback");
        } else {
          expect(message).toMatchObject({
            stopReason: "error",
            errorCode: "OPERATOR_MODEL_POLICY_DENIED",
          });
          expect(requests).toEqual([]);
          expect(accepted).not.toHaveBeenCalled();
          expect(settled).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([result]);
      }
    },
  );
});
