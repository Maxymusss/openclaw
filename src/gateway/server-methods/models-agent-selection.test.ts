import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { migratePersistedImplicitMainRoster } from "../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  registerGatewayModelCatalogPrivateAccess,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { createChatMetadataOwner } from "./chat-metadata-runtime.test-support.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

describe("models.list ordinary agent selection", () => {
  it.each(["raw", "migrated"])(
    "uses the configured system agent before the %s legacy default",
    async (shape) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const raw = {
          agents: {
            defaults: { systemAgent: { agentId: "beta" } },
            entries: { alpha: { default: true }, beta: {} },
          },
        } satisfies OpenClawConfig;
        const config =
          shape === "migrated"
            ? (migratePersistedImplicitMainRoster(raw).config as OpenClawConfig)
            : raw;
        const owner = createChatMetadataOwner(config, "selection-fixture");
        const load = vi.fn(async (params?: { agentId?: string }) => {
          const agentId = expectDefined(params?.agentId, "selected catalog agent");
          return {
            agentId,
            agentDir: resolveAgentDir(config, agentId),
            workspaceDir: resolveAgentWorkspaceDir(config, agentId),
            config,
            observationConfig: config,
            isCurrent: () => true,
            catalogComplete: false,
            entries: [],
            routeVariants: [],
            authMaterializations: [],
            authStore: { version: 1, profiles: {} },
            authModes: {},
            metadataSnapshot: owner.metadataSnapshot,
          } satisfies PreparedGatewayModelCatalogSnapshot;
        });
        registerGatewayModelCatalogPrivateAccess(load, {
          readPrepared: load,
          loadDeferred: load,
        });
        const params = { view: "configured", includeDefaultModels: false };
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          modelsHandlers["models.list"],
          "models.list handler",
        )({
          req: { type: "req", id: "ordinary-agent-selection", method: "models.list", params },
          params,
          context: createDirectChatContext({
            getRuntimeConfig: () => config,
            loadGatewayModelCatalogSnapshot: load,
          }),
          client: null,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(true, { models: [] }, undefined);
        expect(load).toHaveBeenCalledWith({ agentId: "beta" });
        expect(load.mock.calls.every(([request]) => request?.agentId === "beta")).toBe(true);
      });
    },
  );
});
