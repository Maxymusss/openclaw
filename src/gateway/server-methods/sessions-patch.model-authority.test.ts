import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { RespondFn } from "./types.js";

describe("caller-local session patch model presentation", () => {
  it.each(["hidden", "allowed", "unrestricted", "widened", "tightened"] as const)(
    "commits an own-session label patch while projecting a %s model",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const client = roleClient("view", "model-patch-owner");
        client.connect.scopes = ["operator.sessions.write"];
        const cfg = rolePolicyConfig();
        cfg.agents = { defaults: { model: "openai/gpt-5" } };
        const role = expectDefined(cfg.gateway?.roles?.definitions.view, "operator role");
        role.scopes = ["operator.sessions.write"];
        if (mode !== "unrestricted") {
          role.models = {
            allow: [
              mode === "allowed" || mode === "tightened" ? "openai/gpt-5" : "openai/gpt-5-mini",
            ],
          };
        }
        const scope = { agentId: "main", sessionKey: "agent:main:model-label" };
        const original: SessionEntry = {
          sessionId: "model-label-generation",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-5",
          modelProvider: "openai",
          model: "gpt-5",
          authProfileOverride: "shared-credential",
          agentHarnessId: "fixture-runtime",
          acp: {
            backend: "fixture-runtime",
            agent: "fixture",
            runtimeSessionName: "fixture-thread",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 1,
            runtimeOptions: { model: "openai/gpt-5", thinking: "low" },
          },
          fallbackNotice: {
            kind: "active",
            selectedModel: "openai/gpt-5",
            activeModel: "openai/gpt-5",
          },
          pendingTranscriptRepair: [
            {
              id: "repair",
              text: "Retained answer",
              provider: "openai",
              model: "gpt-5",
              createdAt: 1,
            },
          ],
          systemPromptReport: {
            source: "run",
            generatedAt: 1,
            provider: "openai",
            model: "gpt-5",
            systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
            injectedWorkspaceFiles: [],
            skills: { promptChars: 0, entries: [] },
            tools: { listChars: 0, schemaChars: 0, entries: [] },
          },
          createdActor: {
            type: "human" as const,
            source: "profile" as const,
            id: client.authenticatedUserProfile!.profileId,
          },
        };
        await upsertSessionEntryCore(scope, original);
        expect(loadSessionEntry(scope)?.createdActor).toEqual(original.createdActor);
        const catalog = {
          entries: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }],
          routeVariants: [],
          agentId: "main",
          agentDir: state.agentDir("main"),
          workspaceDir: state.workspaceDir,
          config: cfg,
          catalogComplete: true,
        };
        const context = createDirectChatContext({
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: async () => {
            if (mode === "widened" || mode === "tightened") {
              role.models = { allow: [mode === "widened" ? "openai/gpt-5" : "openai/gpt-5-mini"] };
            }
            return catalog;
          },
        });
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "label-patch",
            method: "sessions.patch",
            params: { key: scope.sessionKey, label: "Changed label" },
          },
          context,
          client,
          respond,
          isWebchatConnect: () => false,
          extraHandlers: sessionMutationHandlers,
        });
        expect(respond).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            entry: expect.objectContaining({
              sessionId: original.sessionId,
              label: "Changed label",
            }),
          }),
          undefined,
        );
        const result = respond.mock.calls[0]![1];
        if (mode === "hidden" || mode === "widened" || mode === "tightened") {
          expect(result).not.toHaveProperty("resolved");
          for (const field of [
            "model",
            "modelProvider",
            "modelOverride",
            "providerOverride",
            "authProfileOverride",
            "agentHarnessId",
            "acp",
            "fallbackNotice",
            "systemPromptReport.provider",
            "systemPromptReport.model",
            "pendingTranscriptRepair.0.provider",
            "pendingTranscriptRepair.0.model",
          ]) {
            expect(result).not.toHaveProperty(`entry.${field}`);
          }
          expect(result).toMatchObject({
            entry: {
              pendingTranscriptRepair: [{ id: "repair", text: "Retained answer", createdAt: 1 }],
            },
          });
        } else {
          expect(result).toMatchObject({
            entry: {
              model: "gpt-5",
              modelProvider: "openai",
              modelOverride: "gpt-5",
              providerOverride: "openai",
              authProfileOverride: "shared-credential",
              agentHarnessId: original.agentHarnessId,
              acp: original.acp,
              fallbackNotice: original.fallbackNotice,
              systemPromptReport: original.systemPromptReport,
              pendingTranscriptRepair: original.pendingTranscriptRepair,
            },
            resolved: { model: "gpt-5", modelProvider: "openai" },
          });
        }
        expect(loadSessionEntry(scope)).toMatchObject({
          ...original,
          updatedAt: expect.any(Number),
          label: "Changed label",
        });
      });
    },
  );
});
