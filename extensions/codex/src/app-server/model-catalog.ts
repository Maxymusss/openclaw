import { randomUUID } from "node:crypto";
import type { AgentHarnessModelCatalogParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import {
  createSubsystemLogger,
  isDiagnosticFlagEnabled,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
} from "./auth-profile.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { listAllCodexAppServerModels, type CodexAppServerModel } from "./models.js";
import { probeCodexNativeAuth } from "./native-auth.js";
import type { CodexGetAccountResponse } from "./protocol.js";
import type { CodexControlRequestObservation } from "./request-observation.js";
import { withCodexAppServerJsonClient, type CodexAppServerScopedRequest } from "./request.js";
import { captureSharedCodexAppServerCatalogLifetime } from "./shared-client.js";

// Manifest contract (openclaw.plugin.json discovery.timeoutMs default): live model
// discovery is bounded tightly so a wedged app-server degrades to the static catalog.
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 2500;
type ModelInputType = NonNullable<ModelCatalogEntry["input"]>[number];
const INPUT_TYPES: ReadonlySet<string> = new Set(["text", "image", "audio", "video", "document"]);
const log = createSubsystemLogger("codex/model-catalog");

function isModelInputType(value: string): value is ModelInputType {
  return INPUT_TYPES.has(value);
}

function codexAppServerModelsToCatalogEntries(
  models: readonly CodexAppServerModel[],
  runtime: string,
): ModelCatalogEntry[] {
  return models.map((model, providerOrder) => {
    const input = model.inputModalities.filter(isModelInputType);
    const runtimeParams = buildCodexRuntimeModelParams(model.id, model.model);
    return {
      provider: "openai",
      id: model.id,
      name: model.displayName ?? model.id,
      providerOrder,
      nativeRuntime: runtime,
      reasoning: model.supportedReasoningEfforts.length > 0,
      ...(input.length > 0 ? { input } : {}),
      ...(runtimeParams ? { params: runtimeParams } : {}),
      compat: {
        supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
      },
    };
  });
}

/** One harness registration owns its observations; none travel with worker snapshots. */
export function createCodexAppServerModelCatalog(runtime: string) {
  type Observation = {
    pluginConfig: unknown;
    models?: ReadonlySet<string>;
    accountType?: "apiKey" | "chatgpt";
    authMode?: string;
    isCurrent?: () => boolean;
  };
  const scopes = new WeakMap<AgentHarnessModelCatalogParams["config"], Map<string, Observation>>();
  const scopeKey = (params: AgentHarnessModelCatalogParams) =>
    JSON.stringify([params.agentId, params.agentDir, params.workspaceDir]);
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    read(
      params: AgentHarnessModelCatalogParams & { provider: string; modelId: string },
      pluginConfig: unknown,
    ) {
      const observation = scopes.get(params.config)?.get(scopeKey(params));
      return !disposed &&
        params.provider === "openai" &&
        observation !== undefined &&
        observation.pluginConfig === pluginConfig &&
        observation.models?.has(params.modelId) &&
        observation.accountType &&
        observation.isCurrent?.()
        ? {
            accountType: observation.accountType,
            ...(observation.authMode ? { authMode: observation.authMode } : {}),
          }
        : undefined;
    },
    async load(
      params: AgentHarnessModelCatalogParams,
      pluginConfig: unknown,
    ): Promise<ModelCatalogEntry[]> {
      if (disposed) {
        return [];
      }
      let observations = scopes.get(params.config);
      if (!observations) {
        observations = new Map();
        scopes.set(params.config, observations);
      }
      const key = scopeKey(params);
      const observation: Observation = { pluginConfig };
      // Revoke before any await, including failed/disabled refreshes and superseded reads.
      observations.set(key, observation);
      const configured = readCodexPluginConfig(pluginConfig);
      const discovery = configured.discovery;
      if (discovery?.enabled === false) {
        return [];
      }
      const options = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const ownsLocalProcess =
        options.start.transport === "stdio" && !isCodexAppServerProxyLaunch(options.start.args);
      const authProfileStore =
        ownsLocalProcess && options.start.homeScope === "agent"
          ? resolveCodexAppServerAuthProfileStore({
              agentDir: params.agentDir,
              config: params.config,
            })
          : undefined;
      const authProfileId = authProfileStore
        ? resolveCodexAppServerAuthProfileId({ store: authProfileStore, config: params.config })
        : undefined;
      const usesNativeHome = ownsLocalProcess && options.start.homeScope === "user";
      const native = usesNativeHome ? await probeCodexNativeAuth({ pluginConfig }) : undefined;
      if ((usesNativeHome && !native) || disposed || observations.get(key) !== observation) {
        return [];
      }
      const { start } = options;
      const timeoutMs = discovery?.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
      const traceId = isDiagnosticFlagEnabled("codex.model-catalog", params.config)
        ? randomUUID()
        : undefined;
      const trace: Array<Record<string, string | number | null>> = [];
      let observedRecords = 0;
      let clientInstanceId: string | null = null;
      let transportPid: number | null = null;
      let requestOrdinal = 0;
      let activeMethod: string | null = null;
      const record = (event: string, fields: Record<string, string | number | null> = {}) => {
        if (!traceId) {
          return;
        }
        try {
          trace.push({
            sequence: ++observedRecords,
            at: Date.now(),
            event,
            clientInstanceId,
            transportPid,
            requestOrdinal,
            activeMethod,
            ...fields,
          });
          if (trace.length > 64) {
            trace.shift();
          }
        } catch {
          // Observation must preserve the request result, including falsy rejection values.
        }
      };
      const controlObservation: CodexControlRequestObservation | undefined = traceId
        ? {
            phase(phase) {
              if (phase === "acquire-client") {
                clientInstanceId = null;
                transportPid = null;
              }
              record("phase", { phase });
            },
            failed({ phase, category }) {
              record("failure", { phase, category });
            },
          }
        : undefined;
      const result = await withCodexAppServerJsonClient(
        {
          startOptions: start,
          config: params.config,
          agentDir: params.agentDir,
          timeoutMs,
          ...(controlObservation ? { controlObservation } : {}),
          ...(authProfileStore ? { authProfileStore, authProfileId } : {}),
        },
        async (request, client) => {
          if (traceId) {
            try {
              clientInstanceId = client.getInstanceId();
              transportPid = client.getTransportPid() ?? null;
              record("client-acquired");
            } catch {
              // Unavailable identity stays unobserved; never infer it from a shared RPC id.
            }
          }
          const observedRequest: CodexAppServerScopedRequest = async <T>(
            input: Parameters<CodexAppServerScopedRequest>[0],
          ) => {
            activeMethod = input.method;
            requestOrdinal += 1;
            record("request-start");
            try {
              const response = await request<T>(input);
              record("request-resolved");
              return response;
            } catch (error) {
              record("request-rejected");
              throw error;
            } finally {
              activeMethod = null;
            }
          };
          const catalogRequest = traceId ? observedRequest : request;
          const isCurrent = captureSharedCodexAppServerCatalogLifetime(client);
          const listed = await listAllCodexAppServerModels({
            request: catalogRequest,
            limit: 100,
            includeHidden: true,
          });
          const models = listed.models.filter(
            (model) =>
              !model.hidden ||
              params.configuredModelRefs?.some(
                (ref) => ref.provider === "openai" && ref.model === model.id,
              ),
          );
          const account = await catalogRequest<CodexGetAccountResponse>({
            method: "account/read",
            requestParams: { refreshToken: false },
          });
          const observedType = account.account?.type;
          const accountType = account.requiresOpenaiAuth
            ? observedType === "apiKey" || observedType === "chatgpt"
              ? observedType
              : undefined
            : undefined;
          return { models, isCurrent, accountType } as const;
        },
      ).catch((error: unknown) => {
        if (traceId) {
          try {
            log.warn(
              `[codex-model-catalog-trace] ${JSON.stringify({
                traceId,
                observedRecords,
                omittedRecords: observedRecords - trace.length,
                records: trace,
                rpcIds: "unobserved by scoped request API",
                foregroundJoin: "unobserved",
              })}`,
            );
          } catch {
            // A diagnostic sink must never replace the original catalog rejection.
          }
        }
        throw error;
      });
      // Publish only after the bounded operation settles; a late timed-out callback cannot publish.
      if (disposed || observations.get(key) !== observation || !result.isCurrent()) {
        return [];
      }
      observation.models = new Set(result.models.map((model) => model.id));
      observation.accountType =
        !usesNativeHome ||
        (native?.mode === "api-key" && result.accountType === "apiKey") ||
        ((native?.mode === "oauth" || native?.mode === "token") && result.accountType === "chatgpt")
          ? result.accountType
          : undefined;
      observation.isCurrent = result.isCurrent;
      // A remote ChatGPT account does not distinguish OAuth from caller-supplied tokens.
      // Carry the local mode only after its account type matches this discovery observation.
      observation.authMode =
        observation.accountType === "apiKey"
          ? "api_key"
          : observation.accountType === "chatgpt" &&
              (native?.mode === "oauth" || native?.mode === "token")
            ? native.mode
            : undefined;
      return codexAppServerModelsToCatalogEntries(result.models, runtime);
    },
  };
}
