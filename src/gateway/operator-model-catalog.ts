import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelsListResult,
} from "../../packages/gateway-protocol/src/schema/model-catalog.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { BUILTIN_AGENT_HARNESS_METADATA } from "../agents/harness/builtin-openclaw-metadata.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { OperatorModelPolicyError } from "../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  intersectOperatorPermissionCeilings,
  operatorModelAllowed,
} from "../shared/operator-permissions.js";
import { resolveGatewayAgentSelectionState } from "./agent-list.js";
import type { UserModelAccountSelection } from "./model-account-authority.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorPermissionCeiling,
  resolveOperatorRolePolicy,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { ChatMetadataResult } from "./server-methods/chat-metadata-contract.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";

function catalogRole(client: GatewayClient | null, cfg: OpenClawConfig) {
  const actor = resolveGatewayOperatorRoleActor(client);
  return !client ||
    (!actor && client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID)
    ? undefined
    : resolveOperatorRolePolicy(client, cfg);
}

/** Agent discovery follows the role's existing creation/run ceiling; shared session reads remain separate. */
export function listOperatorModelCatalogAgentIds(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): string[] {
  const allowed = catalogRole(client, cfg)?.agents;
  return listAgentIds(cfg).filter((id) => !allowed || allowed === "*" || allowed.includes(id));
}

export function resolveOperatorModelCatalogAgentId(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
  requested?: string,
): string | undefined {
  // Ordinary omitted requests still use the canonical selection-required resolver.
  if (!Array.isArray(catalogRole(client, cfg)?.agents)) {
    return requested;
  }
  const ids = listOperatorModelCatalogAgentIds(client, cfg);
  if (requested && ids.includes(requested)) {
    return requested;
  }
  const first = ids[0];
  if (requested || first === undefined) {
    throw new OperatorModelPolicyError(
      "Your operator role has no access to this agent's model catalog.",
    );
  }
  const preferred = resolveGatewayAgentSelectionState(cfg).defaultId;
  return ids.includes(preferred) ? preferred : first;
}

function runtimeSupportsModelCeiling(id: string): boolean {
  const harness =
    id === "openclaw" ? BUILTIN_AGENT_HARNESS_METADATA : getRegisteredAgentHarness(id)?.harness;
  return harness?.operatorModelPolicySupport === "exact";
}

/** Keeps caller restrictions out of process-wide prepared catalog caches. */
export function captureOperatorModelCatalogAccess(
  options: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "hasCurrentClientAuthority"
  >,
) {
  const { client, context, signal } = options;
  const source = captureGatewayOperatorRunAuthority(options);
  try {
    const original = resolveOperatorPermissionCeiling(client, context.getRuntimeConfig());
    const originalAgentIds = new Set(
      listOperatorModelCatalogAgentIds(client, context.getRuntimeConfig()),
    );
    const originalAgents = catalogRole(client, context.getRuntimeConfig())?.agents;
    const originalAgentCeiling = Array.isArray(originalAgents)
      ? new Set(originalAgents)
      : undefined;
    const permissions = () => {
      signal?.throwIfAborted();
      source?.authority.assertCurrent();
      if (options.hasCurrentClientAuthority?.() === false) {
        throw new OperatorModelPolicyError("Gateway caller authority is no longer active.");
      }
      return intersectOperatorPermissionCeilings(
        original,
        resolveOperatorPermissionCeiling(client, context.getRuntimeConfig()),
      );
    };
    const allowsRef = (ref: string | undefined): boolean => {
      const ceiling = permissions();
      if (!ceiling?.models) {
        return true;
      }
      const parsed = ref ? parseProviderModelRef(ref) : null;
      return parsed !== null && operatorModelAllowed(ceiling, parsed.provider, parsed.model);
    };
    const allowsAgent = (id: string): boolean => {
      permissions();
      const current = catalogRole(client, context.getRuntimeConfig())?.agents;
      return (
        (!originalAgentCeiling || originalAgentCeiling.has(id)) &&
        (!current || current === "*" || current.includes(id))
      );
    };
    const projectModels = (models: ModelChoice[]): ModelChoice[] => {
      const ceiling = permissions();
      if (!ceiling?.models) {
        return models;
      }
      return models
        .filter((model) => operatorModelAllowed(ceiling, model.provider, model.id))
        .map((model) => {
          const runtimeChoices = model.runtimeChoices?.map((choice) =>
            runtimeSupportsModelCeiling(choice.agentRuntime.id)
              ? choice
              : {
                  ...choice,
                  available: false,
                  unavailableReason: "unsupported-runtime" as const,
                  unavailableUntil: undefined,
                },
          );
          return {
            ...model,
            ...(runtimeSupportsModelCeiling(model.agentRuntime?.id ?? "openclaw")
              ? {}
              : {
                  available: false,
                  unavailableReason: "unsupported-runtime" as const,
                  unavailableUntil: undefined,
                }),
            ...(runtimeChoices ? { runtimeChoices } : {}),
          };
        });
    };
    const allowsAccountSelection = (
      result: Pick<ModelsListResult, "models" | "accountSelection">,
      selectedRef?: string,
      draft?: UserModelAccountSelection,
    ) => {
      const account = result.accountSelection;
      if (!account || account.kind === "automatic" || allowsRef(selectedRef)) {
        return true;
      }
      // The draft owner already authorized this exact personal account. Its catalog,
      // rather than a possibly hidden default, owns the models the picker can select.
      draft?.assertCurrent();
      return (
        draft !== undefined &&
        account.kind === "personal" &&
        account.authProfileId === draft.authProfileId &&
        result.models.some((model) => allowsRef(`${model.provider}/${model.id}`))
      );
    };
    return {
      assertCurrent: () => {
        permissions();
      },
      release: () => source?.release(),
      restricted: () => permissions()?.models !== undefined,
      permissions,
      allowsRef,
      allowsAgent,
      agentIds: () => {
        permissions();
        return listOperatorModelCatalogAgentIds(client, context.getRuntimeConfig()).filter((id) =>
          originalAgentIds.has(id),
        );
      },
      projectModels,
      projectMetadata: (
        metadata: ChatMetadataResult,
        selectedRef?: string,
        draft?: UserModelAccountSelection,
      ): ChatMetadataResult => {
        permissions();
        const { models, accountSelection, ...rest } = metadata;
        return {
          ...rest,
          ...(models ? { models: projectModels(models) } : {}),
          ...(accountSelection &&
          allowsAccountSelection({ ...metadata, models: models ?? [] }, selectedRef, draft)
            ? { accountSelection }
            : {}),
        };
      },
      projectCatalog: (
        result: ModelsListResult,
        selectedRef?: string,
        draft?: UserModelAccountSelection,
      ): ModelsListResult => {
        const ceiling = permissions();
        if (!ceiling?.models) {
          return result;
        }
        const providers = new Set(
          ceiling.models.allow
            .map((ref) => parseProviderModelRef(ref))
            .filter((ref) => ref !== null)
            .map((ref) => normalizeProviderId(ref.provider)),
        );
        const {
          models,
          decisionModels,
          defaultModels,
          pendingProviders,
          providerOutcomes,
          accountSelection,
          ...rest
        } = result;
        return {
          ...rest,
          models: projectModels(models),
          ...(decisionModels
            ? {
                decisionModels: decisionModels.filter((model) =>
                  operatorModelAllowed(ceiling, model.provider, model.id),
                ),
              }
            : {}),
          ...(defaultModels
            ? {
                defaultModels: {
                  automaticUtilityModel: allowsRef(defaultModels.automaticUtilityModel ?? undefined)
                    ? defaultModels.automaticUtilityModel
                    : null,
                },
              }
            : {}),
          ...(pendingProviders
            ? {
                pendingProviders: pendingProviders.filter((provider) =>
                  providers.has(normalizeProviderId(provider)),
                ),
              }
            : {}),
          ...(providerOutcomes
            ? {
                providerOutcomes: providerOutcomes
                  .filter((outcome) => providers.has(normalizeProviderId(outcome.provider)))
                  .map(({ provider, status }) => ({ provider, status })),
              }
            : {}),
          ...(accountSelection && allowsAccountSelection(result, selectedRef, draft)
            ? { accountSelection }
            : {}),
        };
      },
    };
  } catch (error) {
    source?.release();
    throw error;
  }
}
