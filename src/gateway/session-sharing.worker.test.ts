import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import { historyPages } from "../config/sessions/session-transcript-worker-resources.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

it.each(["before-read", "before-consume"] as const)(
  "rejects membership revoked %s without retaining an allow decision",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      const client = roleClient("view", "worker-member");
      const scope = { agentId: "main", sessionKey: "agent:main:worker-sharing" };
      replaceSessionEntrySync(scope, {
        sessionId: "sharing-current",
        updatedAt: 1,
        visibility: "private",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      addSessionMember(scope, {
        identityId: client.authenticatedUserProfile!.profileId,
        addedBy: "another-profile",
      });
      const host = observeHostDataSql();
      let authorization;
      try {
        const result = await resolveSessionMutationAuthorizationAsync({
          client,
          method: "chat.send",
          requestParams: scope,
          context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
        });
        expect(result.error).toBeNull();
        authorization = result.authorization!;
        await authorization.withCurrent!(() => authorization.assertCurrent());
        expect(host.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      } finally {
        host.restore();
      }
      const revoke = () => removeSessionMember(scope, client.authenticatedUserProfile!.profileId);
      const read = historyPages.run.bind(historyPages);
      let revoked = false;
      const spy = vi.spyOn(historyPages, "run").mockImplementation(async (...args) => {
        const reply = await read(...args);
        if (
          boundary === "before-consume" &&
          !revoked &&
          reply.ok &&
          typeof reply.value === "object" &&
          reply.value !== null &&
          "kind" in reply.value &&
          reply.value.kind === "session-exact-entries"
        ) {
          revoked = true;
          revoke();
        }
        return reply;
      });
      const effect = vi.fn();
      try {
        if (boundary === "before-read") revoke();
        await expect(authorization.withCurrent!(effect)).rejects.toThrow();
        expect(effect).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it.each(["membership", "owner", "routing"] as const)(
  "rejects %s invalidation within the consuming frame",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client = roleClient("view", "scoped-member");
      const scope = { agentId: "main", sessionKey: "agent:main:scoped-sharing" };
      replaceSessionEntrySync(scope, {
        sessionId: "scoped-current",
        updatedAt: 1,
        visibility: "private",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      addSessionMember(scope, {
        identityId: client.authenticatedUserProfile!.profileId,
        addedBy: "another-profile",
      });
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(result.error).toBeNull();
      const authorization = result.authorization!;
      let closing: Promise<void> | undefined;
      let checked = false;
      const outcome = authorization.withCurrent!(() => {
        authorization.assertCurrent();
        if (change === "membership")
          removeSessionMember(scope, client.authenticatedUserProfile!.profileId);
        else if (change === "owner") closing = closeOpenClawAgentDatabasesAsync();
        else cfg = { ...cfg, session: { store: "replacement/sessions.json" } };
        expect(() => authorization.assertCurrent()).toThrow();
        checked = true;
      });
      if (change === "owner") await expect(outcome).rejects.toThrow();
      else await outcome;
      await closing;
      expect(checked).toBe(true);
    });
  },
);

it.each(["role", "agent", "sandbox"] as const)(
  "rechecks prepared %s policy at the next worker admission",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg = rolePolicyConfig();
      const client = roleClient("view", "policy-member");
      const scope = { agentId: "main", sessionKey: "agent:main:policy-sharing" };
      replaceSessionEntrySync(scope, {
        sessionId: "policy-current",
        updatedAt: 1,
        visibility: "private",
        createdActor: { type: "human", source: "profile", id: "another-profile" },
      });
      addSessionMember(scope, {
        identityId: client.authenticatedUserProfile!.profileId,
        addedBy: "another-profile",
      });
      const result = await resolveSessionMutationAuthorizationAsync({
        client,
        method: "chat.send",
        requestParams: scope,
        context: { getRuntimeConfig: () => cfg } as GatewayRequestContext,
      });
      expect(result.error).toBeNull();
      if (change === "role") setUserProfileRole(client.authenticatedUserProfile!.profileId, "none");
      else {
        const roles = cfg.gateway!.roles!;
        cfg = {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            roles: {
              ...roles,
              definitions: {
                ...roles.definitions,
                view: {
                  ...roles.definitions.view!,
                  ...(change === "agent" ? { agents: [] } : { sandbox: "required" as const }),
                },
              },
            },
          },
        };
      }
      const effect = vi.fn();
      await expect(result.authorization!.withCurrent!(effect)).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
    });
  },
);
