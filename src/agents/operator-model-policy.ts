import { AsyncLocalStorage } from "node:async_hooks";
import { inheritModelRequestBinding, type Model } from "@openclaw/llm-core";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import {
  intersectOperatorPermissionCeilings,
  operatorModelAllowed,
} from "../shared/operator-permissions.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-operator-authority.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";
import type { StreamFn } from "./runtime/index.js";

const operatorModelRequest = new AsyncLocalStorage<{
  authority: AdmittedRunOperatorAuthority | undefined;
}>();

// Weak provenance only: compositions belong to their request, never a global pair cache.
const composedAuthorityLeaves = new WeakMap<
  AdmittedRunOperatorAuthority,
  readonly AdmittedRunOperatorAuthority[]
>();

function retainAuthorityLeaves(leaves: readonly AdmittedRunOperatorAuthority[]): () => void {
  const releases: Array<() => void> = [];
  const release = () => {
    const errors: unknown[] = [];
    for (const close of releases.splice(0).toReversed()) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Operator model source release failed.");
    }
  };
  try {
    for (const leaf of leaves) {
      leaf.assertCurrent();
      if (leaf.retain) {
        releases.push(leaf.retain());
      }
    }
  } catch (error) {
    const failures = [error];
    try {
      release();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Operator model source acquisition failed.", {
        cause: error,
      });
    }
    throw error;
  }
  return release;
}

function currentOperatorModelAuthority(authority: AdmittedRunOperatorAuthority | undefined) {
  const ambient = operatorModelRequest.getStore()?.authority;
  if (!authority || !ambient || authority === ambient) {
    return authority ?? ambient;
  }
  try {
    assertAdmittedRunOperatorAuthority(authority);
    assertAdmittedRunOperatorAuthority(ambient);
  } catch (cause) {
    throw new OperatorModelPolicyError("Operator model authority must be issued by the host.", {
      cause,
    });
  }
  const originalLeaves = composedAuthorityLeaves.get(ambient) ?? [ambient];
  const suppliedLeaves = composedAuthorityLeaves.get(authority) ?? [authority];
  if (suppliedLeaves.every((leaf) => originalLeaves.includes(leaf))) {
    return ambient;
  }
  if (originalLeaves.every((leaf) => suppliedLeaves.includes(leaf))) {
    return authority;
  }
  const leaves = Object.freeze([...new Set([...originalLeaves, ...suppliedLeaves])]);
  let permissions = ambient.permissions;
  let scopes = ambient.scopes;
  let executionPolicy = ambient.executionPolicy;
  let foregroundRunId = ambient.foregroundRunId;
  let foregroundDeadlineAt = ambient.foregroundDeadlineAt;
  for (const leaf of leaves) {
    const originalGrant = ambient.gatewayAccessGrant;
    const grant = leaf.gatewayAccessGrant;
    if (
      leaf.source !== ambient.source ||
      leaf.profileId !== ambient.profileId ||
      (originalGrant && grant
        ? originalGrant.pluginId !== grant.pluginId || originalGrant.grantId !== grant.grantId
        : originalGrant !== grant) ||
      (foregroundRunId !== undefined &&
        leaf.foregroundRunId !== undefined &&
        foregroundRunId !== leaf.foregroundRunId)
    ) {
      throw new OperatorModelPolicyError(
        "The retained model source does not belong to this request. Start a new request with current authority.",
      );
    }
    permissions = intersectOperatorPermissionCeilings(permissions, leaf.permissions);
    scopes = intersectOperatorScopes(scopes, leaf.scopes);
    executionPolicy ??= leaf.executionPolicy;
    foregroundRunId ??= leaf.foregroundRunId;
    if (leaf.foregroundDeadlineAt !== undefined) {
      foregroundDeadlineAt = Math.min(
        foregroundDeadlineAt ?? leaf.foregroundDeadlineAt,
        leaf.foregroundDeadlineAt,
      );
    }
  }
  const signals = [...new Set(leaves.flatMap((leaf) => (leaf.signal ? [leaf.signal] : [])))];
  const combined = createAdmittedRunOperatorAuthority({
    ...ambient,
    permissions,
    scopes,
    executionPolicy,
    foregroundRunId,
    foregroundDeadlineAt,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    // Call the original captures directly; resolving ALS here would compose recursively.
    assertCurrent: () => {
      for (const leaf of leaves) {
        leaf.assertCurrent();
      }
    },
    retain: () => retainAuthorityLeaves(leaves),
  });
  composedAuthorityLeaves.set(combined, leaves);
  return combined;
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
  return inheritModelRequestBinding<StreamFn>(
    (model, context, options) =>
      runWithOperatorModelRequest(authority, () => {
        assertOperatorModelAllowed(authority, model.provider, model.id);
        requireOperatorModelDelegateSupport(stream.modelRequestBinding);
        return stream(model, context, options);
      }),
    stream,
  );
}

/** Cached delegates stay caller-neutral; check after each plugin model rewrite/await. */
export function guardOperatorModelProviderStream(stream: StreamFn): StreamFn {
  return inheritModelRequestBinding<StreamFn>((model, context, options) => {
    requireOperatorModelDelegateSupport(stream.modelRequestBinding);
    assertOperatorModelAllowed(
      operatorModelRequest.getStore()?.authority,
      model.provider,
      model.id,
    );
    return stream(model, context, options);
  }, stream);
}

/** Unsupported delegates must stop before provider effects, including direct completions. */
export function requireOperatorModelDelegateSupport(support: "wire-model-v1" | undefined): void {
  const original = currentOperatorModelAuthority(undefined);
  assertOperatorModelAuthorityCurrent(original);
  if (original?.permissions?.models && support !== "wire-model-v1") {
    throw new OperatorModelPolicyError(
      "The selected transport cannot bind your model restrictions to its request. Choose a supported HTTP transport.",
    );
  }
}

/** The serializer borrows this request-local source; the existing inference owner retains it. */
export function captureOperatorModelRequest(model: Model) {
  const original = currentOperatorModelAuthority(undefined);
  if (!original?.permissions?.models) {
    return undefined;
  }
  assertOperatorModelAllowed(original, model.provider, model.id);
  const assertCurrent = () => assertOperatorModelAuthorityCurrent(original);
  return {
    assertCurrent,
    bindWireModel(initial: string | undefined, requestModel: Model) {
      assertOperatorModelAllowed(original, requestModel.provider, requestModel.id);
      const { provider, id, api, baseUrl } = requestModel;
      const validate = (current: Model, wireModel: string | undefined) => {
        assertCurrent();
        if (
          !initial ||
          wireModel !== initial ||
          current.provider !== provider ||
          current.id !== id ||
          current.api !== api ||
          current.baseUrl !== baseUrl
        ) {
          throw new OperatorModelPolicyError(
            "The provider payload changed or obscured the authorized model route. Select the model before preparing the request.",
          );
        }
      };
      validate(requestModel, initial);
      return validate;
    },
  };
}
