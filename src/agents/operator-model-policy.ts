import { AsyncLocalStorage } from "node:async_hooks";
import { inheritModelRequestBinding, type Model } from "@openclaw/llm-core";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { parseOperatorModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindModelRequestRoute, readModelRequestRoute } from "../llm/model-runtime-binding.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-operator-authority.js";
import { resolveConfiguredAgentId, resolveAmbientOwnerAgentId } from "./agent-scope-config.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { normalizeProviderId } from "./model-ref-shared.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";
import type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";
import type { StreamFn } from "./runtime/index.js";

export type { PreparedOperatorModelPolicy } from "./operator-model-policy.types.js";

type ModelRequestRoute = NonNullable<ReturnType<typeof readModelRequestRoute>>["routes"][number];

const operatorModelRequest = new AsyncLocalStorage<{
  authority: AdmittedRunOperatorAuthority | undefined;
  route?: NonNullable<ReturnType<typeof readModelRequestRoute>>;
}>();

// Weak provenance only: compositions belong to their request, never a global pair cache.
const composedAuthorityLeaves = new WeakMap<
  AdmittedRunOperatorAuthority,
  readonly AdmittedRunOperatorAuthority[]
>();

function acquireAuthorityLeaves(
  leaves: readonly AdmittedRunOperatorAuthority[],
  acquire: (leaf: AdmittedRunOperatorAuthority) => (() => void) | undefined,
): () => void {
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
      const acquiredRelease = acquire(leaf);
      if (acquiredRelease) {
        releases.push(acquiredRelease);
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
    retain: () => acquireAuthorityLeaves(leaves, (leaf) => leaf.retain?.()),
    onModelPolicyChanged: (listener) =>
      acquireAuthorityLeaves(leaves, (leaf) => leaf.onModelPolicyChanged?.(listener)),
    get modelPolicy() {
      const policies = leaves
        .map((leaf) => leaf.modelPolicy)
        .filter((policy): policy is PreparedOperatorModelPolicy => policy !== undefined);
      const first = policies[0];
      if (!first) {
        return undefined;
      }
      const allows = (ref: ModelRef) => policies.every((policy) => policy.allows(ref));
      return Object.freeze({
        models: Object.freeze(first.models.filter(allows)),
        allows,
      });
    },
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
  return operatorModelRequest.run({ ...operatorModelRequest.getStore(), authority: original }, () =>
    run(original),
  );
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
  if (original?.modelPolicy?.allows({ provider, model }) === false) {
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
  if (original?.modelPolicy && harness.operatorModelPolicySupport !== "exact") {
    throw new OperatorModelPolicyError(
      "The selected runtime cannot enforce your operator model restrictions. Choose a supported runtime or ask an administrator to configure one.",
    );
  }
}

/** Install inside retry/transform wrappers so each actual provider tuple is checked. */
export function wrapOperatorModelStream(
  stream: StreamFn,
  authority: AdmittedRunOperatorAuthority | undefined,
  preparedModel?: Model,
): StreamFn {
  return inheritModelRequestBinding<StreamFn>(
    (model, context, options) =>
      runWithOperatorModelSelection(authority, preparedModel ?? model, () => {
        assertOperatorModelRequestRoute(authority, model);
        requireOperatorModelDelegateSupport(stream.modelRequestBinding);
        return stream(model, context, options);
      }),
    stream,
  );
}

/** Cached delegates stay caller-neutral; check after each plugin model rewrite/await. */
export function guardOperatorModelProviderStream(stream: StreamFn): StreamFn {
  return inheritModelRequestBinding<StreamFn>((model, context, options) => {
    const request = captureOperatorModelRequest(model);
    const run = () => {
      requireOperatorModelDelegateSupport(stream.modelRequestBinding);
      assertOperatorModelRequestRoute(undefined, model);
      return stream(model, context, options);
    };
    return request ? request.run(run) : run();
  }, stream);
}

/** Unsupported delegates must stop before provider effects, including direct completions. */
export function requireOperatorModelDelegateSupport(support: "wire-model-v1" | undefined): void {
  const original = currentOperatorModelAuthority(undefined);
  assertOperatorModelAuthorityCurrent(original);
  if (original?.modelPolicy && support !== "wire-model-v1") {
    throw new OperatorModelPolicyError(
      "The selected transport cannot bind your model restrictions to its request. Choose a supported HTTP transport.",
    );
  }
}

/** Selection facts are host-owned; a late wrapper cannot authorize another allowed route. */
export function assertOperatorModelRequestRoute(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: Model,
): void {
  assertModelRequestRoute(
    authority,
    model,
    operatorModelRequest.getStore()?.route ?? readModelRequestRoute(model),
  );
}

/** Preparation checks its own host selection; it must not borrow an outer inference route. */
export function assertOperatorModelSelection(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: ModelRequestRoute,
): void {
  assertModelRequestRoute(authority, model, readModelRequestRoute(model));
}

function assertModelRequestRoute(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: ModelRequestRoute,
  selected: ReturnType<typeof readModelRequestRoute>,
): void {
  const original = currentOperatorModelAuthority(authority);
  const logical = selected?.logicalRef ?? { provider: model.provider, model: model.id };
  assertOperatorModelAllowed(original, logical.provider, logical.model);
  if (
    original?.modelPolicy &&
    selected &&
    !selected.routes.some(
      (route) =>
        route.provider === model.provider &&
        route.id === model.id &&
        route.api === model.api &&
        route.baseUrl === model.baseUrl,
    )
  ) {
    throw new OperatorModelPolicyError(
      "The provider changed the prepared model route. Select the model before preparing the request.",
    );
  }
}

/** Only an inference owner starts a new selection; delegate/serializer captures reuse it. */
export function runWithOperatorModelSelection<T>(
  authority: AdmittedRunOperatorAuthority | undefined,
  model: Model,
  run: () => T,
): T {
  return runWithOperatorModelRequest(authority, (original) => {
    const route =
      readModelRequestRoute(model) ??
      readModelRequestRoute(
        bindModelRequestRoute(model, { provider: model.provider, model: model.id }),
      );
    return operatorModelRequest.run({ authority: original, route }, () => {
      assertOperatorModelRequestRoute(original, model);
      return run();
    });
  });
}

/** The serializer borrows this request-local source; the existing inference owner retains it. */
export function captureOperatorModelRequest(model: Model) {
  const original = currentOperatorModelAuthority(undefined);
  if (!original?.modelPolicy) {
    return undefined;
  }
  const route =
    operatorModelRequest.getStore()?.route ??
    readModelRequestRoute(model) ??
    readModelRequestRoute(
      bindModelRequestRoute(model, { provider: model.provider, model: model.id }),
    );
  const run = <T>(callback: () => T): T =>
    operatorModelRequest.run({ authority: original, route }, callback);
  const assertCurrent = () => run(() => assertOperatorModelRequestRoute(original, model));
  assertCurrent();
  return {
    run,
    assertCurrent,
    bindWireModel(initial: string | undefined, requestModel: Model) {
      run(() => assertOperatorModelRequestRoute(original, requestModel));
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

const modelPolicyMembership = new WeakMap<PreparedOperatorModelPolicy, string>();

/** A current policy can narrow an original selection but cannot expand its authority. */
export function intersectOperatorModelPolicies(
  original: PreparedOperatorModelPolicy | undefined,
  current: PreparedOperatorModelPolicy | undefined,
): PreparedOperatorModelPolicy | undefined {
  if (!original || !current) {
    return original ?? current;
  }
  return Object.freeze({
    models: Object.freeze(current.models.filter(original.allows)),
    allows: (ref: ModelRef) => original.allows(ref) && current.allows(ref),
  });
}

/** Comparison uses the original predicate, including models outside concrete discovery choices. */
export function readOperatorModelPolicyMembership(
  policy: PreparedOperatorModelPolicy | undefined,
): string | undefined {
  return policy ? modelPolicyMembership.get(policy) : "unrestricted";
}

/** Preserve the already-selected default when allowed, otherwise use the first compatible source choice. */
export function resolveOperatorModelDefault(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    policy: PreparedOperatorModelPolicy | undefined;
    model: ModelRef;
    allows: (ref: ModelRef) => boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | undefined {
  if (!params.policy || params.policy.allows(params.model)) {
    return params.model;
  }
  const automatic = new Set(prepareAgentModels(params).models.map(identity));
  return params.policy.models.find((ref) => automatic.has(identity(ref)) || params.allows(ref));
}

function identity(ref: ModelRef): string {
  return JSON.stringify([normalizeProviderId(ref.provider), ref.model]);
}

function prepareAgentModels(
  params: { cfg: OpenClawConfig; agentId?: string } & ModelManifestNormalizationContext,
) {
  const normalization = {
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
    allowPluginNormalization: false,
  };
  const primary = resolveDefaultModelForAgent(normalization);
  const selection = { ...normalization, defaultProvider: primary.provider };
  const aliasIndex = buildModelAliasIndex(selection);
  const resolve = (raw: string) =>
    resolveModelRefFromString({ ...selection, raw, aliasIndex })?.ref;
  const models = [primary];
  for (const raw of resolveConfiguredModelFallbacks(params)) {
    const ref = resolve(raw);
    if (ref) {
      models.push(ref);
    }
  }
  return { models, resolve };
}

function prepareRefs(refs: readonly string[], resolve: (raw: string) => ModelRef | undefined) {
  const exact = new Map<string, ModelRef>();
  const wildcards = new Set<string>();
  for (const raw of refs) {
    const wildcard = parseOperatorModelPolicyWildcardRef(raw);
    if (wildcard) {
      wildcards.add(wildcard.key);
    } else {
      const ref = resolve(raw);
      if (ref) {
        exact.set(identity(ref), ref);
      }
    }
  }
  return {
    exact,
    wildcards: [...wildcards].toSorted(),
    patterns: compileGlobPatterns({ raw: [...wildcards], normalize: (raw) => raw }),
  };
}

function matches(prepared: ReturnType<typeof prepareRefs>, ref: ModelRef) {
  return (
    prepared.exact.has(identity(ref)) ||
    matchesAnyGlobPattern(`${normalizeProviderId(ref.provider)}/${ref.model}`, prepared.patterns)
  );
}

/** Prepare once per current role/config view; row and execution checks consume only these facts. */
export function prepareOperatorModelPolicy(
  params: {
    cfg: OpenClawConfig;
    policy: GatewayOperatorRoleDefinition["modelPolicy"];
  } & ModelManifestNormalizationContext,
): PreparedOperatorModelPolicy | undefined {
  const { cfg, policy } = params;
  if (!policy) {
    return undefined;
  }
  const agentId = resolveConfiguredAgentId(
    cfg,
    resolveAmbientOwnerAgentId(cfg, policy.sourceAgent),
  );
  const { models: sourceModels, resolve } = prepareAgentModels({
    cfg,
    agentId,
    manifestPlugins: params.manifestPlugins,
  });
  const allowed =
    policy.allow === undefined
      ? {
          exact: new Map(sourceModels.map((ref) => [identity(ref), ref])),
          wildcards: [],
          patterns: [],
        }
      : prepareRefs(policy.allow, resolve);
  const denied = prepareRefs(policy.deny ?? [], resolve);
  const allows = (ref: ModelRef) => matches(allowed, ref) && !matches(denied, ref);
  const models = [
    ...new Map(
      [...sourceModels, ...allowed.exact.values()].map((ref) => [identity(ref), ref]),
    ).values(),
  ]
    .filter(allows)
    .map((ref) => Object.freeze({ ...ref }));
  const prepared = Object.freeze({
    models: Object.freeze(models),
    allows,
  });
  modelPolicyMembership.set(
    prepared,
    JSON.stringify([
      [...allowed.exact.keys()].toSorted(),
      allowed.wildcards,
      [...denied.exact.keys()].toSorted(),
      denied.wildcards,
    ]),
  );
  return prepared;
}
