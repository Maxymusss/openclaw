/** Prepares compaction extensions and restores the guards reset by resource reload. */
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
} from "../agent-settings.js";
import type { SessionManager } from "../sessions/index.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { createEmbeddedAgentResourceLoader } from "./resource-loader.js";

export async function prepareCompactionSessionSettings(
  runtime: PreparedCompactionRuntime,
  sessionManager: SessionManager,
) {
  const {
    params,
    effectiveCwd,
    agentDir,
    effectiveWorkspace,
    contextTokenBudget,
    provider,
    modelId,
    effectiveModel,
    sessionAgentId,
    sandboxSessionKey,
    runId,
  } = runtime;
  const settingsManager = createPreparedEmbeddedAgentSettingsManager({
    cwd: effectiveCwd,
    agentDir,
    cfg: params.config,
    pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({
      config: params.config,
      env: process.env,
      workspaceDir: effectiveWorkspace,
    }),
    contextTokenBudget,
  });
  // Sets compaction/pruning runtime state and returns extension factories
  // that must be passed to the resource loader for the safeguard to be active.
  const extensionFactories = buildEmbeddedExtensionFactories({
    cfg: params.config,
    sessionManager,
    provider,
    modelId,
    model: effectiveModel,
    contextTokenBudget,
    agentId: sessionAgentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? sandboxSessionKey,
    runId,
  });
  const resourceLoader = createEmbeddedAgentResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();
  // Reloading settings discards prepared compaction overrides and restores
  // runtime auto-compaction, so reapply both guards after reload.
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: params.config,
    contextTokenBudget,
  });
  // contextEngineInfo is intentionally omitted: this guard runs inside the
  // compaction LLM session, which is not the user-facing agent session and
  // has no associated context engine.
  applyAgentAutoCompactionGuard({
    settingsManager,
    silentOverflowProneProvider: isSilentOverflowProneModel({
      provider,
      modelId,
      baseUrl: effectiveModel.baseUrl ?? undefined,
    }),
  });
  return { settingsManager, resourceLoader };
}
