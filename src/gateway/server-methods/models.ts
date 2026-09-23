import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
// Models gateway methods expose prepared, cached, and explicitly refreshed catalog views.
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import {
  isOperatorModelPolicyError,
  OperatorModelPolicyError,
} from "../../agents/operator-model-policy.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import {
  captureOperatorModelCatalogAccess,
  resolveOperatorModelCatalogAgentId,
} from "../operator-model-catalog.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";
export { buildModelsListResult };

// Ordinary reads return saved rows while expired provider inventory refreshes in the background.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async (options) => {
    const { params, respond, context, client } = options;
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    let scope: ChatMetadataReadParams | undefined;
    let access: ReturnType<typeof captureOperatorModelCatalogAccess> | undefined;
    try {
      access = captureOperatorModelCatalogAccess(options);
      const scoped = Boolean(params.sessionKey || params.authProfileId);
      scope = scoped ? resolveChatMetadataReadParams(options, params) : undefined;
      if (scoped && !scope) {
        return;
      }
      const cfg = context.getRuntimeConfig();
      const resolved =
        scope ??
        resolveAgentIdOrRespondError({
          rawAgentId:
            resolveOperatorModelCatalogAgentId(
              client,
              cfg,
              normalizeOptionalString(params.agentId),
            ) ?? tryResolveAmbientOwnerAgentId(cfg),
          respond,
          cfg,
          normalize: normalizeOptionalString,
        });
      if (!resolved) {
        return;
      }
      access.assertCurrent();
      if (!scope?.sessionEntry && !access.allowsAgent(resolved.agentId)) {
        throw new OperatorModelPolicyError(
          "Your operator role has no access to this agent's model catalog.",
        );
      }
      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: resolved.agentId,
        params,
        includeManualSelection: hasGatewayClientCap(
          client?.connect.caps,
          GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
        ),
        requesterProfileId: scope?.requesterProfileId ?? resolveAuthenticatedProfileId(client),
        ...(scope ? { readScope: scope } : {}),
      });
      scope?.draftAccountSelection?.assertCurrent();
      scope?.assertCurrent?.();
      access.assertCurrent();
      if (!scope?.sessionEntry && !access.allowsAgent(resolved.agentId)) {
        throw new OperatorModelPolicyError(
          "Your operator role has no access to this agent's model catalog.",
        );
      }
      const projected =
        scope && params.view !== "provider-config"
          ? {
              ...result,
              models: projectSessionModelCatalog(scope, result.models, context.getRuntimeConfig()),
            }
          : result;
      const selected = resolveSessionModelRef(cfg, scope?.sessionEntry, resolved.agentId, {
        allowPluginNormalization: false,
      });
      respond(
        true,
        access.projectCatalog(
          projected,
          `${selected.provider}/${selected.model}`,
          scope?.draftAccountSelection,
        ),
        undefined,
      );
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true, retryAfterMs: 0 }),
        );
        return;
      }
      if (
        !(error instanceof ModelAccountConnectAuthorityError) &&
        !isOperatorModelPolicyError(error)
      ) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, formatErrorMessage(error)));
    } finally {
      access?.release();
      scope?.release?.();
    }
  },
};
