import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { runWithOperatorModelRequest } from "../../agents/operator-model-policy.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { createLlmCompleteError } from "./runtime-llm-error.js";
import type { LlmCompleteCaller, LlmCompleteParams, LlmCompleteResult } from "./types-core.js";

type CompletionOperatorSource = {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
  assertCurrent: () => void;
  assertAuthorityCurrent: () => void;
  bindModelExecution: (
    model: ModelRef | undefined,
  ) => ReturnType<typeof bindOperatorModelExecution>;
};

/** Keep the original requester through preparation, provider work, and asynchronous cleanup. */
export function bindLlmOperatorAuthority(
  hostCaller: LlmCompleteCaller | undefined,
  complete: (
    params: LlmCompleteParams,
    source: CompletionOperatorSource,
  ) => Promise<LlmCompleteResult>,
  originalAuthority?: AdmittedRunOperatorAuthority,
): (params: LlmCompleteParams) => Promise<LlmCompleteResult> {
  return (params) =>
    runWithOperatorModelRequest(originalAuthority, (original) =>
      runWithAsyncWorkResources(async (onAcquired) => {
        // Only the host-issued context-engine capability identifies bounded system maintenance.
        // A request's caller/purpose fields cannot change its execution authority.
        if (hostCaller?.kind === "context-engine" && !original) {
          return await complete(params, {
            signal: params.signal,
            assertCurrent: () => params.signal?.throwIfAborted(),
            assertAuthorityCurrent: () => {},
            bindModelExecution: () => undefined,
          });
        }
        const capturedOperator: ReturnType<typeof captureAmbientGatewayOperatorAuthority> = original
          ? { authority: original, release: original.retain?.() }
          : captureAmbientGatewayOperatorAuthority({
              missingBindingError: () =>
                createLlmCompleteError(
                  "LLM_COMPLETION_NOT_AUTHORIZED",
                  "Plugin model completion requires its current Gateway binding.",
                ),
              retainInherited: true,
            });
        const resources = new AsyncDisposableStack();
        if (capturedOperator?.release) {
          resources.defer(capturedOperator.release);
        }
        onAcquired({ release: () => resources.disposeAsync() });
        const operatorAuthority = capturedOperator?.authority;
        const signal = operatorAuthority?.signal
          ? params.signal
            ? AbortSignal.any([params.signal, operatorAuthority.signal])
            : operatorAuthority.signal
          : params.signal;
        const assertAuthorityCurrent = () => {
          capturedOperator.assertInvocationCurrent?.();
          operatorAuthority?.assertCurrent();
          operatorAuthority?.signal?.throwIfAborted();
        };
        const assertCurrent = () => {
          assertAuthorityCurrent();
          signal?.throwIfAborted();
        };
        assertCurrent();
        return await runWithOperatorModelRequest(operatorAuthority, () =>
          complete(params, {
            operatorAuthority,
            signal,
            assertCurrent,
            assertAuthorityCurrent,
            bindModelExecution: (model) => {
              const execution = bindOperatorModelExecution(operatorAuthority, model);
              if (execution) {
                resources.defer(execution.release);
              }
              return execution;
            },
          }),
        );
      }),
    );
}
