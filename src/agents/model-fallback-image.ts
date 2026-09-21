/** Runs image model candidates through the shared fallback attempt machinery. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import {
  type ModelFallbackErrorHandler,
  type ModelFallbackRunResult,
  runFallbackAttempt,
  throwFallbackFailureSummary,
} from "./model-fallback-attempt.js";
import { resolveImageFallbackCandidates } from "./model-fallback-candidates.js";
import type { FallbackAttempt } from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  assertOperatorModelAllowed,
  restrictOperatorModelCandidates,
} from "./operator-model-policy.js";

export async function runWithImageModelFallback<T>(params: {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
  abortSignal?: AbortSignal;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = restrictOperatorModelCandidates(
    params.operatorAuthority,
    resolveImageFallbackCandidates({
      cfg: params.cfg,
      modelOverride: params.modelOverride,
      manifestPlugins: params.manifestPlugins,
    }),
  );
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const [i, candidate] of candidates.entries()) {
    assertOperatorModelAllowed(params.operatorAuthority, candidate.provider, candidate.model);
    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      attempt: i + 1,
      total: candidates.length,
      abortSignal: params.abortSignal,
    }).catch((error: unknown) => {
      params.abortSignal?.throwIfAborted();
      throw error;
    });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    const err = attemptRun.error;
    lastError = err;
    attempts.push({
      provider: candidate.provider,
      model: candidate.model,
      error: formatErrorMessage(err),
    });
    await params.onError?.({
      provider: candidate.provider,
      model: candidate.model,
      error: err,
      attempt: i + 1,
      total: candidates.length,
    });
  }

  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
    cfg: params.cfg,
  });
}
