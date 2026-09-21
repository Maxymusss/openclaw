import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ModelFallbackRuntimeContext,
  ModelFallbackRunFn,
  ModelFallbackErrorHandler,
  ModelFallbackStepHandler,
  ModelFallbackResultClassifier,
} from "./model-fallback-attempt.js";
import type {
  ModelFallbackCandidate,
  ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";

export type RunWithModelFallbackParams<T> = ModelFallbackRuntimeContext & {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  userLockedAuthProfileId?: string;
  prepareCandidateChain?: (candidates: readonly ModelFallbackCandidate[]) => Promise<void> | void;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
  /** Return false when a thrown attempt committed work that must not be replayed. */
  canFallbackAfterError?: (
    attempt: Parameters<ModelFallbackErrorHandler>[0],
  ) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: { latestResult: T; preferredResult: T }) => T;
  skipAuthProfileRuntime?: boolean;
  abortSignal?: AbortSignal;
} & ModelManifestNormalizationContext;
