import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";

export function createAttemptSetupFixture(
  overrides: Partial<EmbeddedAttemptSetup> = {},
): EmbeddedAttemptSetup {
  let environment = { sandbox: overrides.sandbox ?? null, assertCurrent: () => {} };
  return {
    agentCoreThinkingLevel: "off",
    providerThinkingLevel: undefined,
    effectiveCwd: "/tmp/workspace",
    effectiveWorkspace: "/tmp/workspace",
    effectiveFsWorkspaceOnly: false,
    resolvedWorkspace: "/tmp/workspace",
    sessionPermissionRoot: "/tmp/workspace",
    sessionPermissionPolicy: undefined,
    get sandbox() {
      return environment.sandbox;
    },
    readEnvironment: () => environment,
    prepareEnvironment: async (custody) => ({
      sandbox: environment.sandbox,
      assertCurrent: custody.assertCurrent,
    }),
    publishEnvironment: (next) => {
      environment = next;
    },
    sandboxSessionKey: "session",
    sessionAgentId: "main",
    emitCorePluginToolStageSummary: () => {},
    emitPrepStageSummary: () => {},
    getCurrentAttemptPluginMetadataSnapshot: () => undefined,
    getProviderRuntimeHandle: () => ({
      provider: "provider",
      modelId: "model",
      workspaceDir: "/tmp/workspace",
      prepared: true,
    }),
    prepStages: createEmbeddedRunStageTracker(),
    proactiveSubagentOrchestration: false,
    ...overrides,
  };
}
