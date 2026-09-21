import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { toolsInvokeHandlers } from "./server-methods/tools-invoke.js";
import type { RespondFn } from "./server-methods/types.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

const runtime = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  beforeHook:
    vi.fn<typeof import("../agents/agent-tools.before-tool-call.js").runBeforeToolCallHook>(),
  acquire: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => runtime.cfg,
}));
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: runtime.beforeHook,
}));
// Only model preparation/transport is doubled. Tool registration, Gateway routing,
// caller wrappers, lazy runtime acquisition and model authorization remain real.
vi.mock("../agents/simple-completion-runtime.js", async () => ({
  ...(await import("../agents/simple-completion-execution.js")),
  acquireSimpleCompletionModelForAgent: runtime.acquire,
  resolveSimpleCompletionSelectionForAgent: () => ({
    provider: "fixture",
    modelId: "default",
    agentDir: "/tmp/model-authority-agent",
  }),
}));

vi.mock("../llm/stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/stream.js")>()),
  completeSimple: runtime.complete,
}));

describe("standalone registered plugin completion authority", () => {
  it.each([
    "allowed",
    "denied",
    "widened",
    "revoked",
    "provider-revoked",
    "provider-widened",
    "system",
  ])("retains the original %s source through tool and runtime preparation", async (mode) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const pluginDir = state.path("model-tool");
        fs.mkdirSync(pluginDir);
        const plugin = createColdPluginFixture({
          rootDir: pluginDir,
          pluginId: "model-authority-tool",
          manifest: { contracts: { tools: ["model_probe"] } },
        });
        fs.writeFileSync(
          plugin.runtimeSource,
          `module.exports = {
          id: "model-authority-tool",
          register(api) {
            api.registerTool({ name: "model_probe", label: "Model probe", description: "Complete a fixture request.",
              parameters: { type: "object", properties: {} },
              async execute() {
                const result = await api.runtime.llm.complete({ messages: [{ role: "user", content: "probe" }] });
                return { content: [{ type: "text", text: result.text }], details: result };
              }
            });
          }
        };`,
        );
        const client = roleClient("view", "standalone-model-owner");
        client.connect.scopes = ["operator.write"];
        const cfg = rolePolicyConfig();
        const role = expectDefined(cfg.gateway?.roles?.definitions.view, "model role");
        role.scopes = ["operator.write"];
        role.models = {
          allow: [
            mode === "denied" || mode === "widened" || mode === "system"
              ? "fixture/other"
              : "fixture/default",
          ],
        };
        cfg.agents = { defaults: { workspace: state.workspaceDir, model: "fixture/default" } };
        cfg.plugins = {
          load: { paths: [pluginDir] },
          slots: { memory: "none" },
          entries: { [plugin.pluginId]: { enabled: true } },
        };
        cfg.tools = { allow: ["model_probe"] };
        runtime.cfg = cfg;
        await state.writeConfig(cfg);
        const source = new AbortController();
        client.internal = {
          ...client.internal,
          operatorAccessAuthority: {
            signal: source.signal,
            assertCurrent: () => source.signal.throwIfAborted(),
          },
          ...(mode === "system" ? { operatorRoleActor: { kind: "system" as const } } : {}),
        };
        // The real tools.invoke resolver installs a metadata-only Gateway caller wrapper.
        // A trusted system actor remains explicit at the authenticated request boundary.
        if (mode === "system") {
          delete client.authenticatedUserProfile;
        }
        const entered = createDeferred();
        const release = createDeferred();
        runtime.beforeHook.mockReset().mockImplementation(async ({ params }) => {
          if (mode === "widened" || mode === "revoked") {
            entered.resolve();
            await release.promise;
          }
          return { blocked: false, params };
        });
        runtime.acquire.mockReset().mockImplementation(async () => {
          if (mode === "provider-revoked" || mode === "provider-widened") {
            entered.resolve();
            await release.promise;
          }
          return {
            async [Symbol.asyncDispose]() {},
            selection: { provider: "fixture", modelId: "default", agentDir: state.agentDir() },
            model: {
              provider: "fixture",
              id: mode === "provider-widened" ? "other" : "default",
              name: "Fixture",
              api: "openai-completions",
              baseUrl: "https://fixture.invalid",
              input: ["text"],
              reasoning: false,
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            auth: { apiKey: "fixture-key", source: "test", mode: "api-key" },
          };
        });
        runtime.complete.mockReset().mockResolvedValue({
          content: [{ type: "text", text: "completed" }],
          stopReason: "stop",
          usage: { input: 1, output: 1, total: 2 },
        });
        const respond = vi.fn<RespondFn>();
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: "model-tool",
            method: "tools.invoke",
            params: { name: "model_probe" },
          },
          client,
          respond,
          isWebchatConnect: () => false,
          context: createDirectChatContext({ getRuntimeConfig: () => runtime.cfg }),
          extraHandlers: toolsInvokeHandlers,
        });
        try {
          if (["widened", "revoked", "provider-revoked", "provider-widened"].includes(mode)) {
            expect(
              await Promise.race([entered.promise.then(() => true), request.then(() => false)]),
            ).toBe(true);
            if (mode === "widened" || mode === "provider-widened") {
              role.models = { allow: ["fixture/other", "fixture/default"] };
            } else {
              source.abort(new Error("original plugin model source revoked"));
            }
            release.resolve();
          }
          await request;
          expect(runtime.beforeHook).toHaveBeenCalledOnce();
          expect(respond).toHaveBeenCalledOnce();
          if (mode === "allowed" || mode === "system") {
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                ok: true,
                source: "plugin",
                output: expect.objectContaining({
                  details: expect.objectContaining({ text: "completed", model: "default" }),
                }),
              }),
              undefined,
            );
            expect(runtime.complete).toHaveBeenCalledOnce();
          } else {
            expect(respond).toHaveBeenCalledWith(
              true,
              expect.objectContaining({
                ok: false,
                error: { code: "internal_error", message: "tool execution failed" },
              }),
              undefined,
            );
            expect(runtime.complete).not.toHaveBeenCalled();
          }
        } finally {
          release.resolve();
          await request.catch(() => {});
          resetPluginLoaderTestStateForTest();
          clearPluginMetadataLifecycleCaches();
        }
      },
    );
  });
});
