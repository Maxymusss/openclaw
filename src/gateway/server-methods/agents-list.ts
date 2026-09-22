import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateAgentsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  isOperatorModelPolicyError,
  OperatorModelPolicyError,
} from "../../agents/operator-model-policy.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureOperatorModelCatalogAccess } from "../operator-model-catalog.js";
import { listAgentsForGateway } from "../session-utils.js";
import {
  readPreparedServerMethodModelCatalog,
  readPreparedServerMethodModelCatalogs,
} from "./optional-model-catalog.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentListHandler: GatewayRequestHandler = async (options) => {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateAgentsListParams, "agents.list", respond)) {
    return;
  }

  let release: (() => void) | undefined;
  try {
    const access = captureOperatorModelCatalogAccess(options);
    release = access.release;
    const cfg = context.getRuntimeConfig();
    const agentIds = access.agentIds();
    if (agentIds.length === 0) {
      throw new OperatorModelPolicyError("Your operator role has no available agents.");
    }
    const modelCatalogByAgentId = context.readPreparedGatewayModelCatalogBatch
      ? await readPreparedServerMethodModelCatalogs(context, agentIds)
      : new Map(
          await Promise.all(
            agentIds.map(
              async (agentId) =>
                [
                  agentId,
                  await readPreparedServerMethodModelCatalog(context, { agentId }),
                ] as const,
            ),
          ),
        );
    access.assertCurrent();
    const result = await listAgentsForGateway(cfg, undefined, {
      isAgentAllowed: access.allowsAgent,
      modelCatalogByAgentId,
      includeSystem: hasGatewayClientCap(client?.connect.caps, GATEWAY_CLIENT_CAPS.AGENT_KIND),
      httpAvatarBasePath:
        client?.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI
          ? (cfg.gateway?.controlUi?.basePath ?? "")
          : undefined,
    });
    const agents: typeof result.agents = [];
    for (const agent of result.agents.filter((row) => access.allowsAgent(row.id))) {
      if (!access.restricted()) {
        agents.push(agent);
        continue;
      }
      const {
        model,
        utilityModel,
        agentRuntime,
        thinkingLevels,
        thinkingOptions,
        thinkingDefault,
        ...rest
      } = agent;
      const primary = model?.primary;
      const visiblePrimary = Boolean(primary && access.allowsRef(primary));
      agents.push({
        ...rest,
        ...(model
          ? {
              model: {
                ...(visiblePrimary ? { primary } : {}),
                ...(model.fallbacks ? { fallbacks: model.fallbacks.filter(access.allowsRef) } : {}),
              },
            }
          : {}),
        ...(utilityModel && access.allowsRef(utilityModel) ? { utilityModel } : {}),
        ...(visiblePrimary
          ? { agentRuntime, thinkingLevels, thinkingOptions, thinkingDefault }
          : {}),
      });
    }
    const defaultId = agents.find((agent) => agent.id === result.defaultId)?.id ?? agents[0]?.id;
    if (!defaultId) {
      throw new OperatorModelPolicyError("Your operator role has no available agents.");
    }
    respond(true, { ...result, defaultId, agents }, undefined);
  } catch (error) {
    if (!isOperatorModelPolicyError(error)) {
      throw error;
    }
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, formatErrorMessage(error)));
  } finally {
    release?.();
  }
};
