import { AsyncLocalStorage } from "node:async_hooks";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { operatorModelAllowed } from "../shared/operator-permissions.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-operator-authority.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";
import type { StreamFn } from "./runtime/index.js";

const operatorModelRequest = new AsyncLocalStorage<{
  authority: AdmittedRunOperatorAuthority | undefined;
}>();

function currentOperatorModelAuthority(authority: AdmittedRunOperatorAuthority | undefined) {
  return authority ?? operatorModelRequest.getStore()?.authority;
}

/** Optional nested SDK calls keep the original ceiling; omission is not system provenance. */
export function runWithOperatorModelRequest<T>(
  authority: AdmittedRunOperatorAuthority | undefined,
  run: (original: AdmittedRunOperatorAuthority | undefined) => T,
): T {
  const original = currentOperatorModelAuthority(authority);
  assertOperatorModelAuthorityCurrent(original);
  return operatorModelRequest.run({ authority: original }, () => run(original));
}

/** Policy and source denials are terminal; auth/profile/provider fallback cannot repair them. */
export class OperatorModelPolicyError extends Error {
  readonly code = "OPERATOR_MODEL_POLICY_DENIED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperatorModelPolicyError";
  }
}

/** Disposal and provider wrappers must not turn a policy denial into failover. */
export function isOperatorModelPolicyError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) =>
      candidate instanceof OperatorModelPolicyError ||
      (candidate !== null &&
        typeof candidate === "object" &&
        (("code" in candidate && candidate.code === "OPERATOR_MODEL_POLICY_DENIED") ||
          ("errorCode" in candidate && candidate.errorCode === "OPERATOR_MODEL_POLICY_DENIED"))),
  );
}

/** The custom API bridge preserves terminal policy identity in the assistant error code. */
export function assertOperatorModelResponse(message: {
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
}): void {
  if (message.stopReason === "error" && isOperatorModelPolicyError(message)) {
    throw new OperatorModelPolicyError(message.errorMessage ?? "Operator model authority denied.");
  }
}

export function assertOperatorModelAuthorityCurrent(
  authority: AdmittedRunOperatorAuthority | undefined,
): void {
  const original = currentOperatorModelAuthority(authority);
  if (!original) {
    return;
  }
  try {
    assertAdmittedRunOperatorAuthority(original);
    original.assertCurrent();
  } catch (cause) {
    throw new OperatorModelPolicyError(
      cause instanceof Error ? cause.message : "Operator model authority is no longer active.",
      { cause },
    );
  }
}

/** A logical timeout must not release the source while its provider/cleanup work still runs. */
export function runWithOperatorModelAuthority<T>(
  authority: AdmittedRunOperatorAuthority | undefined,
  run: (original: AdmittedRunOperatorAuthority | undefined) => Promise<T>,
): Promise<T> {
  const original = currentOperatorModelAuthority(authority);
  if (!original) {
    return runWithOperatorModelRequest(undefined, run);
  }
  return runWithAsyncWorkResources(async (onAcquired) => {
    assertOperatorModelAuthorityCurrent(original);
    onAcquired({ release: original.retain?.() ?? (() => {}) });
    return await runWithOperatorModelRequest(original, run);
  });
}

export function assertOperatorModelAllowed(
  authority: AdmittedRunOperatorAuthority | undefined,
  provider: string,
  model: string,
): void {
  const original = currentOperatorModelAuthority(authority);
  assertOperatorModelAuthorityCurrent(original);
  if (!operatorModelAllowed(original?.permissions, provider, model)) {
    throw new OperatorModelPolicyError(
      "Your operator role does not allow this model. Choose an allowed model or ask an administrator to update your role.",
    );
  }
}

export function assertOperatorModelHarnessSupported(
  authority: AdmittedRunOperatorAuthority | undefined,
  harness: { operatorModelPolicySupport?: "exact" },
): void {
  const original = currentOperatorModelAuthority(authority);
  assertOperatorModelAuthorityCurrent(original);
  if (original?.permissions?.models && harness.operatorModelPolicySupport !== "exact") {
    throw new OperatorModelPolicyError(
      "The selected runtime cannot enforce your operator model restrictions. Choose a supported runtime or ask an administrator to configure one.",
    );
  }
}

export function restrictOperatorModelCandidates<T extends ModelFallbackCandidate>(
  authority: AdmittedRunOperatorAuthority | undefined,
  candidates: readonly T[],
): T[] {
  const original = currentOperatorModelAuthority(authority);
  assertOperatorModelAuthorityCurrent(original);
  const allowed = candidates.filter((candidate) => {
    if (candidate.routeOrigin === "requested") {
      assertOperatorModelAllowed(original, candidate.provider, candidate.model);
      return true;
    }
    return operatorModelAllowed(original?.permissions, candidate.provider, candidate.model);
  });
  if (candidates.length && !allowed.length) {
    throw new OperatorModelPolicyError(
      "No configured model is allowed by your operator role. Choose an allowed model or ask an administrator to update the configuration.",
    );
  }
  return allowed;
}

/** Install inside retry/transform wrappers so each actual provider tuple is checked. */
export function wrapOperatorModelStream(
  stream: StreamFn,
  authority: AdmittedRunOperatorAuthority | undefined,
): StreamFn {
  return (model, context, options) =>
    runWithOperatorModelRequest(authority, () => {
      assertOperatorModelAllowed(authority, model.provider, model.id);
      return stream(model, context, options);
    });
}

/** Cached delegates stay caller-neutral; check after each plugin model rewrite/await. */
export function guardOperatorModelProviderStream(stream: StreamFn): StreamFn {
  return (model, context, options) => {
    assertOperatorModelAllowed(
      operatorModelRequest.getStore()?.authority,
      model.provider,
      model.id,
    );
    return stream(model, context, options);
  };
}
