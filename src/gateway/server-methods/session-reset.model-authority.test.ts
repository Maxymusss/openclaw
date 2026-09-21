import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { RespondFn } from "./types.js";

describe.each(["sessions.reset", "sessions.create"])("%s model response privacy", (method) => {
  it.each(["hidden", "allowed", "unrestricted", "system"])(
    "preserves reset selection while publishing only the %s caller view",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const client = roleClient("view", "reset-model-owner");
        client.connect.scopes = ["operator.admin"];
        const cfg = rolePolicyConfig();
        cfg.agents = { defaults: { model: "openai/gpt-5", workspace: state.workspaceDir } };
        cfg.session = { dmScope: "main" };
        const role = expectDefined(cfg.gateway?.roles?.definitions.view, "reset role");
        role.scopes = ["operator.admin"];
        if (mode !== "unrestricted") {
          role.models = { allow: [mode === "allowed" ? "openai/gpt-5" : "openai/gpt-5-mini"] };
        }
        if (mode === "system") {
          client.internal = { operatorRoleActor: { kind: "system" } };
        }
        await state.writeConfig(cfg);
        const scope = { agentId: "main", sessionKey: "agent:main:main" };
        const original = {
          sessionId: "reset-original-generation",
          lifecycleRevision: "reset-original-lifecycle",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5",
          authProfileOverride: "fixture-account",
          authProfileOverrideSource: "user" as const,
          contextWindow: 8192,
          thinkingLevel: "low" as const,
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: client.authenticatedUserProfile!.profileId,
          },
        };
        await upsertSessionEntryCore(scope, original);
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "reset-model",
            method,
            params:
              method === "sessions.reset"
                ? { key: scope.sessionKey, expectedSessionId: original.sessionId }
                : { parentSessionKey: scope.sessionKey, emitCommandHooks: true },
          },
          client,
          respond,
          isWebchatConnect: () => false,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          extraHandlers: { ...sessionCreateHandlers, ...sessionMutationHandlers },
        });
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[2]).toBeUndefined();
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ ok: true, key: scope.sessionKey });
        const stored = expectDefined(loadSessionEntry(scope), "reset stored row");
        expect(stored.sessionId).toBe(original.sessionId);
        expect(stored.lifecycleRevision).not.toBe(original.lifecycleRevision);
        expect(stored).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-5",
          authProfileOverride: "fixture-account",
          contextWindow: 8192,
          thinkingLevel: "low",
        });
        const payload = respond.mock.calls[0]?.[1];
        expect(payload).toMatchObject({ entry: { sessionId: stored.sessionId } });
        if (mode === "hidden") {
          for (const field of [
            "entry.providerOverride",
            "entry.modelOverride",
            "entry.model",
            "entry.modelProvider",
            "entry.authProfileOverride",
            "entry.contextWindow",
            "entry.thinkingLevel",
            "resolved",
          ]) {
            expect(payload).not.toHaveProperty(field);
          }
        } else {
          expect(payload).toMatchObject({
            entry: { providerOverride: "openai", modelOverride: "gpt-5" },
            resolved: { modelProvider: "openai", model: "gpt-5" },
          });
        }
      });
    },
  );
});
