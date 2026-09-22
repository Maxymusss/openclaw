import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import type { OperatorScope } from "../operator-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { connectChatMetadataAccount } from "./chat-metadata-runtime.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export function createPersonalMetadataFixture() {
  const owner = ensureProfileForEmail("metadata-owner@example.test");
  const authProfileId = connectChatMetadataAccount(owner.id);
  const client: NonNullable<GatewayRequestHandlerOptions["client"]> & { connId: string } = {
    connId: "metadata-owner-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: owner.id,
      displayName: owner.displayName,
      hasAvatar: false,
      updatedAt: owner.updatedAt,
    },
  };
  const roleScopes: OperatorScope[] = ["operator.read"];
  const config = {
    gateway: {
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", scopes: roleScopes, sessions: { others: "none" } },
        },
      },
    },
  } satisfies OpenClawConfig;
  const clients = new Set([client]);
  const metadata = { models: [], swarmEnabled: false };
  const readChatMetadata = vi.fn<GatewayRequestContext["readChatMetadata"]>(async () => metadata);
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    readChatMetadata,
    getClientConnIds: (filter) =>
      new Set(
        [...clients]
          .filter((current) => !filter || filter(current))
          .map((current) => current.connId),
      ),
  });
  const request = async (
    params: Record<string, unknown>,
    overrides: Partial<Pick<GatewayRequestHandlerOptions, "client" | "signal">> = {},
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      chatHistoryHandlers["chat.metadata"],
      "metadata handler",
    )({
      params,
      context,
      client,
      respond,
      req: { type: "req", id: "draft-preview", method: "chat.metadata" },
      isWebchatConnect: () => false,
      ...overrides,
    });
    return respond;
  };
  return { owner, authProfileId, client, clients, config, metadata, readChatMetadata, request };
}
