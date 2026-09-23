/**
 * Fresh, prompt-only inference with an exact zero-tool execution contract.
 *
 * This operation deliberately bypasses the ordinary agent attempt, retry,
 * transcript, hook, and delivery lifecycle. Execution owners either prove a
 * literal empty native tool surface or fail before inference starts.
 */
import type { Model } from "../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { assertOperatorModelAllowed } from "./admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { reconcileAuthProfileQuotaBlocks } from "./auth-profiles/usage.js";
import { resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import { resolveAgentHarnessSelectionDecision } from "./harness/selection-decision.js";
import type {
  AgentHarness,
  AgentHarnessIsolatedCompletionAuthorization,
  AgentHarnessIsolatedCompletionResult,
} from "./harness/types.js";
import { runCliIsolatedCompletion } from "./isolated-completion-cli.js";
import { createIsolatedCompletionModelAuthority } from "./isolated-completion-model-authority.js";
import {
  IsolatedCompletionError,
  isRetryableIsolatedQuotaFailure,
  requireIsolatedAssistantText,
} from "./isolated-completion-output.js";
import type {
  RunIsolatedCompletionParams,
  IsolatedCompletionResult,
} from "./isolated-completion.types.js";
import { ensureAuthProfileStore } from "./model-auth.js";
import type { ModelRef } from "./model-ref-shared.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";
import {
  assertOperatorModelAllowed as assertOperatorModelTupleAllowed,
  assertOperatorModelAuthorityCurrent,
  assertOperatorModelHarnessSupported,
  isOperatorModelPolicyError,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "./provider-secret-egress.js";
import { materializePreparedRuntimeModel } from "./runtime-plan/materialize-model.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  preparedAgentRuntimeProfileAttemptHasCandidate,
  type PreparedAgentRuntimeAuthAttempt,
} from "./runtime-plan/prepare-auth.js";
import { scopeAuthProfileStoreToPreparedPlan } from "./runtime-plan/resolve-auth.js";
import { prepareSimpleCompletionModel } from "./simple-completion-runtime.js";

export type { IsolatedCompletionResult } from "./isolated-completion.types.js";

type AgentHarnessIsolatedCompletionParams = Parameters<
  NonNullable<AgentHarness["runIsolatedCompletion"]>
>[0];

function clampIsolatedStreamParams(
  streamParams: RunIsolatedCompletionParams["streamParams"],
  modelMaxTokens: number | undefined,
): RunIsolatedCompletionParams["streamParams"] {
  if (streamParams?.maxTokens === undefined || modelMaxTokens === undefined) {
    return streamParams;
  }
  return { ...streamParams, maxTokens: Math.min(streamParams.maxTokens, modelMaxTokens) };
}

function selectIsolatedHarnessAuthPlan(attempt: PreparedAgentRuntimeAuthAttempt) {
  if (attempt.kind !== "profile") {
    return attempt.plan;
  }
  return {
    ...attempt.plan,
    forwardedAuthProfileId: attempt.profileId,
    // Core owns candidate order. A harness receives one selected credential
    // snapshot per call so it cannot inspect or reorder fallback profiles.
    forwardedAuthProfileCandidateIds: [attempt.profileId],
  };
}

function resolveCliOwner(params: {
  request: RunIsolatedCompletionParams;
  provider: string;
  runtime: string;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
}): string | undefined {
  if (
    isCliRuntimeAliasForProvider({
      runtime: params.runtime,
      provider: params.provider,
      cfg: params.request.config,
    })
  ) {
    return params.runtime;
  }
  if (params.request.agentHarnessRuntimeOverride) {
    // An explicit non-CLI owner is authoritative. Automatic CLI discovery must
    // not bypass that harness or turn its unsupported result into a fallback.
    return undefined;
  }
  return (
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.request.config,
      agentId: params.agentId,
      modelId: params.request.model,
      authProfileId: params.request.authProfileId,
    }) ??
    resolveEmbeddedCliBackendDispatchEligibility({
      provider: params.provider,
      model: params.request.model,
      agentId: params.agentId,
      authProfileId: params.request.authProfileId,
      config: params.request.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })?.provider
  );
}

function prepareIsolatedHostAuthorization<
  T extends Pick<AgentHarnessIsolatedCompletionParams, "model" | "auth">,
>(harness: AgentHarness, authorization: T): T {
  if (harness.id === "openclaw") {
    return authorization;
  }
  // External harnesses are the provider egress boundary. Keep credentials
  // sentinelized until this owner is selected, then hand it usable values.
  const boundary = "plugin harness isolated completion handoff";
  const apiKey = authorization.auth.apiKey
    ? unwrapSecretSentinelsForProviderEgress(authorization.auth.apiKey, boundary)
    : authorization.auth.apiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(authorization.model, boundary);
  if (apiKey === authorization.auth.apiKey && model === authorization.model) {
    return authorization;
  }
  return {
    ...authorization,
    model,
    auth: { ...authorization.auth, apiKey },
  };
}

/** Run one fresh, zero-tool completion through its selected runtime. */
export async function runIsolatedCompletion(
  params: RunIsolatedCompletionParams,
): Promise<IsolatedCompletionResult> {
  return await runWithOperatorModelRequest(params.operatorAuthority, (operatorAuthority) =>
    runWithAsyncWorkResources((onAcquired, captureWorkContext) => {
      assertOperatorModelAuthorityCurrent(operatorAuthority);
      const release = operatorAuthority?.retain?.();
      if (release) {
        onAcquired({ release: async () => release() });
      }
      return runIsolatedCompletionOwned(
        { ...params, operatorAuthority },
        (resources) =>
          onAcquired({
            release: async () => {
              try {
                await resources.release();
              } finally {
                release?.();
              }
            },
          }),
        captureWorkContext,
      );
    }),
  );
}

async function runIsolatedCompletionOwned(
  params: RunIsolatedCompletionParams,
  onAcquired: (resources: { release: () => Promise<void> }) => void,
  captureWorkContext: () => void,
): Promise<IsolatedCompletionResult> {
  // Snapshot caller choices and validators before admission yields; callbacks expire on close.
  const input = {
    ...params,
    streamParams: params.streamParams && { ...params.streamParams },
  };
  input.assertCurrent?.();
  assertOperatorModelAuthorityCurrent(input.operatorAuthority);
  input.abortSignal?.throwIfAborted();
  const requestConfig = input.config ?? {};
  const agentId = input.agentId ?? resolveDefaultAgentId(requestConfig);
  const requestAgentDir = input.agentDir ?? resolveAgentDir(requestConfig, agentId);
  const requestedWorkspaceDir =
    input.workspaceDir ?? resolveAgentWorkspaceDir(requestConfig, agentId);
  const canonicalProvider = resolveCliRuntimeCanonicalProvider({
    runtime: input.provider,
    config: requestConfig,
    includeSetupRegistry: true,
  });
  const provider = canonicalProvider ?? input.provider;
  let closed = false;
  let modelForAuthorization: ModelRef | undefined = { provider, model: input.model };
  const assertCurrent = () => {
    if (closed) {
      throw new IsolatedCompletionError("runtime-unavailable", "Isolated completion has ended.");
    }
    input.assertCurrent?.();
    assertOperatorModelAuthorityCurrent(input.operatorAuthority);
    assertOperatorModelAllowed(input.operatorAuthority, modelForAuthorization);
    input.abortSignal?.throwIfAborted();
  };
  const resolveAuthorizedModel: typeof resolveModelAsync = async (...args) => {
    const resolved = await resolveModelAsync(...args);
    if (resolved.model) {
      modelForAuthorization = resolved.logicalRef;
      assertCurrent();
    }
    return resolved;
  };
  assertCurrent();
  assertOperatorModelTupleAllowed(input.operatorAuthority, provider, input.model);
  // Canonicalizing a CLI model ref must not discard its explicit execution owner.
  const runtimeOverride =
    input.agentHarnessRuntimeOverride ?? (canonicalProvider ? input.provider : undefined);
  const lease = await acquireAgentRunPreparedModelRuntime(
    {
      config: requestConfig,
      agentId,
      agentDir: requestAgentDir,
      workspaceDir: requestedWorkspaceDir,
      preserveWorkspaceDirOnRefresh: input.workspaceDir !== undefined,
    },
    {
      catalogMode: "static",
      abortSignal: input.abortSignal,
      deriveRuntimePluginSelections: () => [
        {
          provider,
          modelId: input.model,
          ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
          agentId,
        },
      ],
    },
  );
  const modelAuthority = createIsolatedCompletionModelAuthority({
    operatorAuthority: input.operatorAuthority,
    abortSignal: input.abortSignal,
    assertCurrent,
    runtime: lease,
  });
  onAcquired({ release: () => modelAuthority.release() });
  try {
    assertCurrent();
    const run = async (): Promise<IsolatedCompletionResult> => {
      captureWorkContext();
      // A new admission owns config and directories; the caller keeps its explicit route and profile.
      const context = {
        config: lease.snapshot.config,
        agentId,
        agentDir: lease.snapshot.agentDir,
        workspaceDir: lease.snapshot.workspaceDir ?? requestedWorkspaceDir,
      };
      const { config, agentDir, workspaceDir } = context;
      const request = { ...input, ...context, assertCurrent };
      await ensureSelectedAgentHarnessPlugin({
        provider,
        modelId: request.model,
        ...context,
        agentHarnessRuntimeOverride: runtimeOverride,
        pluginRegistry: lease.snapshot.pluginRegistry,
      });
      assertCurrent();
      const selection = resolveAgentHarnessSelectionDecision({
        provider,
        modelId: request.model,
        config,
        agentId,
        agentHarnessRuntimeOverride: runtimeOverride,
      });
      const cliOwner = resolveCliOwner({
        request,
        provider,
        runtime: runtimeOverride ?? selection.policy.runtime,
        ...context,
      });
      if (cliOwner) {
        assertOperatorModelHarnessSupported(input.operatorAuthority, {});
        const completion = await runCliIsolatedCompletion({
          request,
          provider: cliOwner,
          modelProvider: provider,
          ...context,
        });
        return {
          text: completion.text,
          provider,
          model: completion.model,
          owner: { kind: "cli", id: cliOwner },
          ...(completion.usage ? { usage: completion.usage } : {}),
        };
      }

      // Retain the validated plugin instance; load the built-in runner only when selected.
      const harness = selection.builtIn
        ? (await import("./harness/builtin-openclaw.js")).createOpenClawAgentHarness(
            input.operatorAuthority,
          )
        : selection.harness;
      assertCurrent();
      assertOperatorModelHarnessSupported(input.operatorAuthority, harness);
      if (!harness.runIsolatedCompletionV2 && !harness.runIsolatedCompletion) {
        throw new IsolatedCompletionError(
          "unsupported",
          `Agent harness ${harness.id} does not support isolated completion.`,
        );
      }
      const commonParams = {
        provider,
        modelId: request.model,
        ...context,
        systemPrompt: request.systemPrompt,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        abortSignal: request.abortSignal,
        assertCurrent,
        thinkLevel: request.thinkLevel,
        outputTextPolicy: request.outputTextPolicy,
      };
      const prepareHostAuthorization = async (
        authProfileId: string | undefined,
      ): Promise<Extract<AgentHarnessIsolatedCompletionAuthorization, { owner: "host" }>> => {
        const prepared = await prepareSimpleCompletionModel(
          {
            cfg: config,
            operatorAuthority: input.operatorAuthority,
            agentId,
            provider,
            modelId: request.model,
            agentDir,
            profileId: authProfileId,
            allowMissingApiKeyModes: ["aws-sdk"],
            allowBundledStaticCatalogFallback: true,
            skipAgentDiscovery: true,
            bindAuthOwner: true,
            workspaceDir,
            preparedModelRuntime: lease.snapshot,
            signal: request.abortSignal,
            modelResolver: resolveAuthorizedModel,
          },
          assertCurrent,
        );
        assertCurrent();
        if ("error" in prepared) {
          throw new Error(`Isolated completion preparation failed: ${prepared.error}`);
        }
        assertOperatorModelTupleAllowed(
          input.operatorAuthority,
          prepared.model.provider,
          prepared.model.id,
        );
        return { owner: "host", ...prepared };
      };
      let result: AgentHarnessIsolatedCompletionResult | undefined;
      if (harness.runIsolatedCompletionV2) {
        let modelMaxTokens: number | undefined;
        let harnessAuth:
          | {
              model: Model;
              store: ReturnType<typeof ensureAuthProfileStore>;
              attempts: readonly PreparedAgentRuntimeAuthAttempt[];
            }
          | undefined;
        if (harness.authBootstrap === "harness") {
          const resolution = await resolveAuthorizedModel(
            provider,
            request.model,
            agentDir,
            config,
            {
              abortSignal: request.abortSignal,
              assertCurrent,
              ...lease.snapshot.createStores(),
              preparedModelRuntime: lease.snapshot,
              workspaceDir,
              authProfileId: request.authProfileId,
              skipAgentDiscovery: true,
              allowBundledStaticCatalogFallback: true,
              preferBundledStaticCatalogTransport: true,
            },
          );
          if (!resolution.model) {
            throw new IsolatedCompletionError(
              "runtime-unavailable",
              resolution.error ?? `Unknown isolated completion model ${provider}/${request.model}.`,
            );
          }
          const runtimeModel = resolution.model;
          assertOperatorModelTupleAllowed(
            input.operatorAuthority,
            runtimeModel.provider,
            runtimeModel.id,
          );
          assertCurrent();
          const authProfileStore = ensureAuthProfileStore(agentDir, {
            profileId: request.authProfileId,
            readOnly: true,
            allowKeychainPrompt: false,
            config,
          });
          const authParams = {
            provider: runtimeModel.provider,
            modelId: runtimeModel.id,
            modelApi: runtimeModel.api,
            modelBaseUrl: runtimeModel.baseUrl,
            ...context,
            env: process.env,
            authProfileStore,
            sessionAuthProfileId: request.authProfileId,
            sessionAuthProfileSource: request.authProfileId ? "user" : undefined,
            ...(request.authProfileId ? { allowAuthProfileFallback: false } : {}),
            harnessId: harness.id,
            harnessRuntime: harness.id,
            harnessAuthBootstrap: harness.authBootstrap,
          } satisfies Parameters<typeof prepareAgentRuntimeAuth>[0];
          await reconcileAuthProfileQuotaBlocks(authParams);
          assertCurrent();
          const authAttempts = prepareAgentRuntimeAuth(authParams).attempts;
          harnessAuth = { model: runtimeModel, store: authProfileStore, attempts: authAttempts };
        }
        // Profile rotation shares one inference budget instead of restarting it per account.
        let deadline: number | undefined;
        const remainingTimeoutMs = () => {
          const remaining = deadline === undefined ? request.timeoutMs : deadline - Date.now();
          if (remaining <= 0) {
            throw new IsolatedCompletionError(
              "runtime-unavailable",
              "Isolated completion timed out.",
            );
          }
          return remaining;
        };
        let firstError: unknown;
        let priorProfileAttempted = false;
        for (const preparedAttempt of harnessAuth?.attempts ?? [undefined]) {
          assertCurrent();
          remainingTimeoutMs();
          const attempt: PreparedAgentRuntimeAuthAttempt | undefined =
            preparedAttempt?.kind === "profile"
              ? { ...preparedAttempt, plan: selectIsolatedHarnessAuthPlan(preparedAttempt) }
              : preparedAttempt;
          if (
            attempt &&
            !canRunPreparedAgentRuntimeAuthAttempt({ attempt, priorProfileAttempted })
          ) {
            firstError ??= new Error("Prepared direct auth requires a prior profile attempt.");
            continue;
          }
          if (
            attempt?.kind === "profile" &&
            harnessAuth &&
            !preparedAgentRuntimeProfileAttemptHasCandidate({
              attempt,
              store: harnessAuth.store,
              modelId: harnessAuth.model.id,
            })
          ) {
            firstError ??= new Error(
              "Prepared runtime auth candidates are temporarily unavailable.",
            );
            continue;
          }
          try {
            let authorization: AgentHarnessIsolatedCompletionAuthorization;
            if (
              attempt?.plan.harnessAuthProvider &&
              attempt.plan.modelRoute?.authRequirement !== "api-key" &&
              harnessAuth
            ) {
              const plan = attempt.plan;
              // Auth owns the resolved model tuple; a manifest alias remains only
              // on the caller's dispatch envelope, not on the materialization target.
              const { model: runtimeModel, store: authProfileStore } = harnessAuth;
              const model = await materializePreparedRuntimeModel({
                plan,
                provider: runtimeModel.provider,
                modelId: runtimeModel.id,
                model: runtimeModel,
                config,
                workspaceDir,
                metadataSnapshot: lease.snapshot.metadataSnapshot,
                resolveModel: ({ config: modelConfig, authProfileId, authProfileMode }) =>
                  resolveAuthorizedModel(
                    runtimeModel.provider,
                    runtimeModel.id,
                    agentDir,
                    modelConfig,
                    {
                      abortSignal: request.abortSignal,
                      assertCurrent,
                      modelIdSource: "selected",
                      preparedModelRuntime: lease.snapshot,
                      workspaceDir,
                      authProfileId,
                      authProfileMode,
                      skipAgentDiscovery: true,
                      allowBundledStaticCatalogFallback: true,
                    },
                  ),
              });
              assertCurrent();
              if (model) {
                assertOperatorModelTupleAllowed(input.operatorAuthority, model.provider, model.id);
              }
              modelMaxTokens = model?.maxTokens;
              authorization = {
                owner: "harness",
                plan,
                authProfileStore: scopeAuthProfileStoreToPreparedPlan(authProfileStore, plan),
              };
            } else {
              authorization = await prepareHostAuthorization(
                attempt?.kind === "profile" ? attempt.profileId : request.authProfileId,
              );
              modelMaxTokens = authorization.model.maxTokens;
            }
            if (
              attempt?.kind === "profile" &&
              harnessAuth &&
              !preparedAgentRuntimeProfileAttemptHasCandidate({
                attempt,
                store: harnessAuth.store,
                modelId: harnessAuth.model.id,
              })
            ) {
              throw new Error("Prepared runtime auth candidates are temporarily unavailable.");
            }
            assertCurrent();
            deadline ??= Date.now() + request.timeoutMs;
            const execution = modelAuthority.bind(modelForAuthorization);
            const pending = harness.runIsolatedCompletionV2({
              ...commonParams,
              ...execution,
              timeoutMs: remainingTimeoutMs(),
              authorization:
                authorization.owner === "host"
                  ? prepareIsolatedHostAuthorization(harness, authorization)
                  : authorization,
              streamParams: clampIsolatedStreamParams(request.streamParams, modelMaxTokens),
            });
            priorProfileAttempted ||= attempt?.kind === "profile";
            const candidate = await pending;
            execution.assertCurrent?.();
            assertCurrent();
            if (isRetryableIsolatedQuotaFailure(candidate.assistant)) {
              // Returned quota failures must enter the same core-owned profile loop as throws.
              // Terminal errors and tool-bearing output never authorize another attempt.
              requireIsolatedAssistantText(candidate.assistant);
            }
            result = candidate;
            break;
          } catch (error) {
            if (isOperatorModelPolicyError(error)) {
              throw error;
            }
            // A retired caller cannot authorize another credential attempt.
            assertCurrent();
            firstError ??= error;
          }
        }
        if (!result) {
          if (firstError instanceof Error) {
            throw firstError;
          }
          throw new Error("No prepared auth attempt succeeded.", { cause: firstError });
        }
      } else {
        const authorization = await prepareHostAuthorization(request.authProfileId);
        const harnessParams: AgentHarnessIsolatedCompletionParams = {
          ...commonParams,
          streamParams: clampIsolatedStreamParams(
            request.streamParams,
            authorization.model.maxTokens,
          ),
          model: authorization.model,
          auth: authorization.auth,
          ...(authorization.sourceAuthFingerprint
            ? { sourceAuthFingerprint: authorization.sourceAuthFingerprint }
            : {}),
        };
        assertCurrent();
        const execution = modelAuthority.bind(modelForAuthorization);
        result = await harness.runIsolatedCompletion!(
          prepareIsolatedHostAuthorization(harness, { ...harnessParams, ...execution }),
        );
        execution.assertCurrent?.();
      }
      if (!result) {
        throw new IsolatedCompletionError("runtime-unavailable", "Isolated completion failed.");
      }
      return {
        text: requireIsolatedAssistantText(result.assistant),
        provider: result.assistant.provider,
        model: result.assistant.model,
        owner: { kind: "harness", id: harness.id },
        usage: result.assistant.usage,
      };
    };
    const result = await withPluginRuntimeGenerationScope(lease.snapshot, run);
    assertCurrent();
    if (!result.text && input.outputTextPolicy !== "strict-visible") {
      throw new IsolatedCompletionError(
        "output-rejected",
        "Isolated completion returned empty output.",
      );
    }
    return result;
  } finally {
    closed = true;
  }
}
