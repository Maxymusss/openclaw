import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { agentListHandler } from "./agents-list.js";
import type { RespondFn } from "./types.js";

function fixture() {
  const client = roleClient("view", "agent-catalog-reader");
  client.connect.scopes = ["operator.sessions.read"];
  const cfg = rolePolicyConfig();
  cfg.agents = {
    ownership: "explicit",
    entries: {
      main: { model: "fixture/hidden" },
      guest: { model: "fixture/allowed" },
    },
  };
  const role = expectDefined(cfg.gateway?.roles?.definitions.view, "reader role");
  role.scopes = ["operator.sessions.read"];
  role.agents = ["guest"];
  role.models = { allow: ["fixture/allowed"] };
  const read = vi.fn(async (agentIds: readonly string[]) =>
    agentIds.map(() => ({ status: "fulfilled" as const, value: { entries: [] } })),
  );
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    readPreparedGatewayModelCatalogBatch: read,
  });
  const respond = vi.fn<RespondFn>();
  const request = () =>
    handleGatewayRequest({
      req: { type: "req", id: "agent-catalog", method: "agents.list", params: {} },
      context,
      client,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { "agents.list": agentListHandler },
    });
  return { role, read, respond, request };
}

describe("caller-local agent catalog", () => {
  it("hydrates only allowed agents and replaces an invisible default with the visible candidate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      await f.request();
      expect(f.read).toHaveBeenCalledExactlyOnceWith(["guest"]);
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          defaultId: "guest",
          agents: [expect.objectContaining({ id: "guest", model: { primary: "fixture/allowed" } })],
        }),
        undefined,
      );
    });
  });

  it("preserves wildcard agents and unrestricted model metadata when ceilings are omitted", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      f.role.agents = "*";
      delete f.role.models;
      await f.request();
      expect(f.read).toHaveBeenCalledExactlyOnceWith(["main", "guest"]);
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          defaultId: "main",
          agents: [
            expect.objectContaining({ id: "main", model: { primary: "fixture/hidden" } }),
            expect.objectContaining({ id: "guest", model: { primary: "fixture/allowed" } }),
          ],
        }),
        undefined,
      );
    });
  });

  it("returns an explicit no-agent outcome before catalog acquisition", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      f.role.agents = [];
      await f.request();
      expect(f.read).not.toHaveBeenCalled();
      expect(f.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          message: "Your operator role has no available agents.",
        }),
      );
    });
  });

  it("does not adopt an agent newly allowed while its original catalog read is pending", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const started = createDeferred();
      const release = createDeferred();
      f.read.mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return [{ status: "fulfilled", value: { entries: [] } }];
      });
      const pending = f.request();
      try {
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error("Agent catalog request completed before its read");
          }),
        ]);
        f.role.agents = ["main"];
        release.resolve();
        await pending;
        expect(f.read).toHaveBeenCalledExactlyOnceWith(["guest"]);
        expect(f.respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: "Your operator role has no available agents.",
          }),
        );
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    });
  });
});
