/** Private client request/startup contracts; type-only to preserve cold runtime loading. */
import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import type { CodexCatalogPreviewCache } from "../session-catalog-native-projection.js";
import type {
  CodexAppServerResolvedPreparedAuth,
  CodexAppServerAuthRequirement,
} from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import type { CodexRequestWaiterFinished, CodexStartupObservation } from "./request-observation.js";
import type { CodexAppServerStartupLifetime } from "./shared-client-lifecycle.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";

export type RequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  catalogPreview?: true;
  catalogPreviewCache?: CodexCatalogPreviewCache;
  catalogRows?: number;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
};

export type CodexAppServerClientStartupOptions = {
  lifetime: CodexAppServerStartupLifetime;
  requestedStartOptions: CodexAppServerStartOptions;
  startOptions: CodexAppServerStartOptions;
  desktopGeneration?: CodexDesktopGeneration;
  pluginConfig?: unknown;
  agentDir?: string;
  authProfileId: string | null | undefined;
  authProfileStore?: AuthProfileStore;
  runtimeArtifactMode?: "capture";
  expectedRuntimeArtifact?: AgentHarnessRuntimeArtifactBinding;
  preparedAuth?: CodexAppServerResolvedPreparedAuth;
  authRequirement?: CodexAppServerAuthRequirement;
  config?: CodexAppServerClientOptions["config"];
  timeoutMs?: number;
  abandonSignal?: AbortSignal;
  onStartedClient?: (client: CodexAppServerClient) => void;
  onInitializedClient?: () => void;
  startupObservation?: CodexStartupObservation;
  assertCurrent?: () => void;
};

/** Factory used by attempt startup and side turns to acquire a leased client. */
export type CodexAppServerClientFactory = (
  options?: CodexAppServerClientOptions,
) => Promise<CodexAppServerClient>;
