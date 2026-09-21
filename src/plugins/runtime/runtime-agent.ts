// Runtime agent helpers resolve agent-scoped directories and config for plugin execution.
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "../../agents/embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  buildConfiguredModelCatalog,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import {
  concretizeAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { normalizeThinkLevel, resolveThinkingProfile } from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as session from "../../config/sessions/lifecycle.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntryCore as patchAccessorSessionEntry,
  replaceSessionEntry,
  type SessionAccessScope,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { normalizeResolvedMaintenanceConfigInput } from "../../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { resolveAgentCatalogCreateTarget } from "./runtime-agent-session-catalog.js";
import { createSessionEntry } from "./runtime-agent-session-creation.js";
import { resolveRuntimeThinkingCatalog } from "./runtime-agent-thinking.js";
import { defineCachedValue } from "./runtime-cache.js";
import type { PluginRuntime } from "./types.js";

type RuntimeSession = PluginRuntime["agent"]["session"];
type RuntimeSessionStoreReadParams = Parameters<RuntimeSession["getSessionEntry"]>[0];
type RuntimeSessionStoreListParams = NonNullable<
  Parameters<RuntimeSession["listSessionEntries"]>[0]
>;
type RuntimeSessionStoreEntrySummary = ReturnType<RuntimeSession["listSessionEntries"]>[number];
type RuntimeSessionStoreEntryUpdateParams = Parameters<
  RuntimeSession["updateSessionStoreEntry"]
>[0];
type RuntimeUpsertSessionEntryParams = Parameters<RuntimeSession["upsertSessionEntry"]>[0];

const loadEmbeddedAgentRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-agent.runtime.js"),
);
const loadAgentCommandRuntime = createLazyRuntimeModule(async () => {
  const [command, identity] = await Promise.all([
    import("../../agents/agent-command.js"),
    import("../../agents/agent-command-execution-identity.js"),
  ]);
  return { command, identity };
});

function toSessionAccessScope(params: RuntimeSessionStoreReadParams): SessionAccessScope {
  // Keep plugin runtime parameters aligned with the public SDK wrapper while
  // avoiding direct exposure of internal accessor-only options.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

function getSessionEntry(params: RuntimeSessionStoreReadParams): SessionEntry | undefined {
  return loadSessionEntryReadOnly(toSessionAccessScope(params));
}

function listSessionEntries(
  params: RuntimeSessionStoreListParams = {},
): RuntimeSessionStoreEntrySummary[] {
  const listEntries = params.readOnly
    ? listAccessorSessionEntriesReadOnly
    : listAccessorSessionEntries;
  return listEntries({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  });
}

async function patchSessionEntry(
  params: Parameters<PluginRuntime["agent"]["session"]["patchSessionEntry"]>[0],
): Promise<SessionEntry | null> {
  return await patchAccessorSessionEntry(toSessionAccessScope(params), params.update, {
    assertCommitAllowed: params.assertCommitAllowed,
    fallbackEntry: params.fallbackEntry,
    maintenanceConfig:
      params.maintenanceConfig !== undefined
        ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
        : undefined,
    preserveActivity: params.preserveActivity,
    replaceEntry: params.replaceEntry,
  });
}

async function updateSessionStoreEntry(
  params: RuntimeSessionStoreEntryUpdateParams,
): Promise<SessionEntry | null> {
  // Maintainer note: keep the legacy object-parameter API here, but route
  // mutations through the session accessor boundary.
  return await updateSessionEntry(
    {
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.update,
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
}

async function upsertSessionEntry(params: RuntimeUpsertSessionEntryParams): Promise<void> {
  // Maintainer note: this compatibility helper has full-entry replacement
  // semantics, so removed fields must not survive as merge leftovers.
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

async function runWithSessionWorkAdmission<T>(
  params: { storePath: string; sessionKey: string; signal?: AbortSignal },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const initialEntry = getSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const lifecycleAbortController = new AbortController();
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, initialEntry?.sessionId],
    signal: params.signal,
    onInterrupt: () =>
      lifecycleAbortController.abort(
        new Error("Agent work interrupted by a session lifecycle change."),
      ),
    assertAllowed: () => {
      const currentEntry = getSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      });
      const changed = initialEntry
        ? !currentEntry || currentEntry.sessionId !== initialEntry.sessionId
        : Boolean(currentEntry);
      if (changed) {
        throw session.createSessionWorkStartChangedError(params.sessionKey);
      }
      const startError = session.resolveSessionWorkStartError(params.sessionKey, currentEntry);
      if (startError) {
        throw new Error(startError);
      }
    },
  });

  try {
    const signal = params.signal
      ? AbortSignal.any([params.signal, lifecycleAbortController.signal])
      : lifecycleAbortController.signal;
    return await admission.run(async () => await run(signal));
  } finally {
    admission.release();
  }
}

/** Creates the plugin runtime agent facade with lazy embedded-agent/session helpers. */
export function createRuntimeAgent(): PluginRuntime["agent"] {
  const agentRuntime = {
    defaults: { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveSessionCatalogCreateTarget: resolveAgentCatalogCreateTarget,
    resolveThinkingDefault,
    normalizeThinkingLevel: normalizeThinkLevel,
    resolveThinkingPolicy: (params) => {
      const cfg = getRuntimeConfig();
      const effectiveRuntime = params.agentRuntime
        ? concretizeAgentRuntime(params.agentRuntime)
        : params.provider && params.model
          ? resolveEffectiveAgentRuntime({
              cfg,
              provider: params.provider,
              modelId: params.model,
            })
          : undefined;
      const profile = resolveThinkingProfile({
        ...params,
        agentRuntime: effectiveRuntime,
        catalog: resolveRuntimeThinkingCatalog(params, () =>
          buildConfiguredModelCatalog({ cfg: getRuntimeConfig() }),
        ),
      });
      const policy: Omit<
        ReturnType<PluginRuntime["agent"]["resolveThinkingPolicy"]>,
        "defaultLevel"
      > = {
        levels: profile.levels.map(({ id, label }) => ({ id, label })),
      };
      return profile.defaultLevel ? { ...policy, defaultLevel: profile.defaultLevel } : policy;
    },
    resolveAgentTimeoutMs,
    resolveCliBackendDispatchEligibility: resolveEmbeddedCliBackendDispatchEligibility,
    ensureAgentWorkspace,
  } satisfies Omit<
    PluginRuntime["agent"],
    "runCommandFromIngress" | "runEmbeddedAgent" | "session"
  > &
    Partial<Pick<PluginRuntime["agent"], "runCommandFromIngress" | "runEmbeddedAgent" | "session">>;

  defineCachedValue(agentRuntime, "runCommandFromIngress", () =>
    createLazyRuntimeMethod(
      loadAgentCommandRuntime,
      ({ command, identity }) =>
        async (
          opts: Parameters<PluginRuntime["agent"]["runCommandFromIngress"]>[0],
          runtime: Parameters<PluginRuntime["agent"]["runCommandFromIngress"]>[1],
        ) =>
          await command.agentCommandFromGatewayIngress(
            {
              ...identity.sanitizePublicAgentCommandIngressOpts(opts),
              senderIsOwner: opts.senderIsOwner === true,
            },
            runtime,
            undefined,
            {},
          ),
    ),
  );
  defineCachedValue(agentRuntime, "runEmbeddedAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedAgentRuntime, (runtime) => runtime.runPluginEmbeddedAgent),
  );
  defineCachedValue(agentRuntime, "session", () => ({
    resolveStorePath: resolveSessionStorePathCore,
    createSessionEntry,
    getSessionEntry,
    listSessionEntries,
    patchSessionEntry,
    upsertSessionEntry,
    runWithWorkAdmission: runWithSessionWorkAdmission,
    updateSessionStoreEntry,
  }));

  return agentRuntime as PluginRuntime["agent"];
}
