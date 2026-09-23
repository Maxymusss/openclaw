import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

const sessionKey = "agent:main:stream";
const sessionEvents = [
  "chat",
  "agent",
  "session.message",
  "session.tool",
  "session.observer",
  "chat.side_result",
  "chat.send_timing",
  "sessions.changed",
] as const;

function sessionReader(scope = "operator.sessions.read") {
  const peer = makeClient("reader", "operator", [scope]);
  Object.assign(peer.client, sharingPolicyClient({ user: "reader", scopes: [scope] }));
  prepareGatewayRecipientProfile(peer.client, {
    identity: { profileId: "reader", aliases: new Set(["reader"]), role: null },
  });
  peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
  return peer;
}

describe("session read event admission", () => {
  it.each(
    sessionEvents.flatMap((event) =>
      ["operator.sessions.read", "operator.sessions.write"].map((scope) => ({ event, scope })),
    ),
  )("delivers $event to a verified $scope recipient through every alias", ({ event, scope }) => {
    const peer = sessionReader(scope);
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(peer.client.connId, "global");
    const canReceiveSessionEvent = vi.fn(() => true);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
      sessionMessageSubscribers: subscribers,
      canReceiveSessionEvent,
    });
    const payload = { sessionKey: "global", runId: "actual-run", state: "final" };
    broadcast(event, payload, { sessionKeys: [" agent:main:global ", "global"], agentId: "main" });
    expect(canReceiveSessionEvent).toHaveBeenCalledExactlyOnceWith(
      peer.client,
      ["agent:main:global", "global"],
      "main",
      event,
      payload,
    );
    expect(peer.socket.events).toEqual([event]);
    expect(JSON.parse(peer.socket.send.mock.calls[0]![0])).toMatchObject({ event, payload });
  });

  it.each(["final", "error", "aborted"])("delivers the exact %s run terminal", (state) => {
    const peer = sessionReader();
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(peer.client.connId, sessionKey);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
      sessionMessageSubscribers: subscribers,
      canReceiveSessionEvent: () => true,
    });
    const payload = { sessionKey: ` ${sessionKey} `, runId: "accepted-run", state };
    broadcast("chat", payload, { sessionKeys: [] });
    expect(peer.socket.events).toEqual(["chat"]);
    expect(JSON.parse(peer.socket.send.mock.calls[0]![0])).toMatchObject({ payload });
  });

  it.each([
    "keyless",
    "blank payload",
    "blank explicit",
    "mixed blank alias",
    "missing fence",
    "hidden",
    "unsubscribed",
    "identityless",
    "unprepared",
    "stale profile",
    "system",
    "owner sentinel",
    "operator with owner identity",
    "node",
    "worker",
    "pairing",
  ])("denies %s even with a targeted verified audience", (denied) => {
    const peer = sessionReader();
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(peer.client.connId, sessionKey);
    const opts: GatewayBroadcastOpts = { sessionSubscriptionVerified: true };
    const payload: { sessionKey?: string } = { sessionKey };
    if (denied === "keyless") {
      delete payload.sessionKey;
    }
    if (denied === "blank payload") {
      payload.sessionKey = " ";
    }
    if (denied === "blank explicit" || denied === "mixed blank alias") {
      opts.sessionKeys = denied === "blank explicit" ? [" "] : [sessionKey, " "];
    }
    if (denied === "identityless") {
      peer.client.authenticatedUserProfile = undefined;
    }
    if (denied === "unprepared") {
      peer.client.preparedSessionProfile = undefined;
    }
    if (denied === "stale profile") {
      peer.client.authenticatedUserProfile!.profileId = "different-profile";
    }
    if (denied === "system") {
      peer.client.internal = { operatorRoleActor: { kind: "system" } };
    }
    if (denied === "owner sentinel" || denied === "operator with owner identity") {
      peer.client.authenticatedUserProfile!.profileId = GATEWAY_OWNER_PROFILE_ID;
      if (denied === "operator with owner identity") {
        peer.client.internal = { operatorRoleActor: { kind: "operator", profileId: "reader" } };
      }
    }
    if (denied === "node") {
      peer.client.connect.role = "node";
    }
    if (denied === "worker") {
      peer.client.connectionKind = "worker";
    }
    if (denied === "pairing") {
      peer.client.connect.scopes = ["operator.pairing"];
    }
    if (denied === "unsubscribed") {
      subscribers.unsubscribe(peer.client.connId, sessionKey);
      opts.sessionSubscriptionVerified = false;
    }
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
      sessionMessageSubscribers: subscribers,
      canReceiveSessionEvent: denied === "missing fence" ? undefined : () => denied !== "hidden",
    });
    broadcastToConnIds("chat", payload, new Set([peer.client.connId]), opts);
    expect(peer.socket.events).toEqual([]);
  });

  it("keeps keyless metadata and broad staff admission separate from session reads", () => {
    const narrow = sessionReader();
    const staff = makeClient("staff", "operator", ["operator.read"]);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([narrow.client, staff.client]),
      canReceiveSessionEvent: () => true,
      preparePresenceProjection: (presence) => () => presence,
    });
    for (const event of sessionEvents) {
      broadcast(event, {});
    }
    for (const event of ["board.changed", "session.sharing", "session.suggestion", "presence"]) {
      broadcast(event, { sessionKey, presence: [] });
    }
    broadcast("chat.metadata.changed", { reason: "roles" });
    expect(narrow.socket.events).toEqual(["chat.metadata.changed"]);
    expect(staff.socket.events).toEqual([
      ...sessionEvents,
      "board.changed",
      "session.sharing",
      "session.suggestion",
      "presence",
      "chat.metadata.changed",
    ]);
  });

  it("uses committed sharing and current prepared roles without reading SQLite during delivery", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { ...rolePolicyConfig(), agents: { list: [{ id: "main", default: true }] } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const peers = [
        { role: "none", label: "owner" },
        { role: "none", label: "foreign" },
        { role: "view", label: "shared-reader" },
      ] as const;
      const [owner, foreign, shared] = peers.map(({ role, label }) => {
        const peer = makeClient(label, "operator", ["operator.sessions.read"]);
        Object.assign(peer.client, roleClient(role, label));
        peer.client.connect.scopes = ["operator.sessions.read"];
        peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
        return peer;
      });
      if (!owner || !foreign || !shared) {
        throw new Error("Missing prepared fixture recipients");
      }
      const rows = [
        { key: sessionKey, visibility: "shared", incognito: false },
        { key: "agent:main:private", visibility: "draft", incognito: false },
        { key: "agent:main:incognito", visibility: "shared", incognito: true },
      ] as const;
      for (const row of rows) {
        await upsertSessionEntryCore(
          { sessionKey: row.key, agentId: "main" },
          {
            sessionId: row.key,
            updatedAt: 1,
            visibility: row.visibility,
            incognito: row.incognito || undefined,
            createdActor: {
              type: "human",
              source: "profile",
              id: owner.client.authenticatedUserProfile!.profileId,
            },
          },
        );
      }
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const connection = createGatewayConnectionState({ bootId: "narrow-session-events", cfg });
      connection.attachSessionRowProjection(projection);
      for (const peer of [owner, foreign, shared]) {
        connection.clients.add(peer.client);
        for (const row of rows) {
          connection.sessionMessageSubscribers.subscribe(peer.client.connId, row.key);
        }
        connection.sessionMessageSubscribers.subscribe(peer.client.connId, "global");
      }
      const send = (key: string, aliases?: string[]) => {
        const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
        const exec = vi.spyOn(DatabaseSync.prototype, "exec");
        const statements = (["all", "get", "run"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        );
        try {
          connection.broadcast(
            "chat",
            { sessionKey: key, runId: "live-run", state: "final" },
            { sessionKeys: aliases, agentId: "main" },
          );
          expect(reads).not.toHaveBeenCalled();
          expect(exec).not.toHaveBeenCalled();
          for (const statement of statements) {
            expect(statement).not.toHaveBeenCalled();
          }
          return [owner, foreign, shared].map(({ socket }) => socket.events.splice(0));
        } finally {
          reads.mockRestore();
          exec.mockRestore();
          for (const statement of statements) {
            statement.mockRestore();
          }
        }
      };
      try {
        expect(send(sessionKey)).toEqual([["chat"], [], ["chat"]]);
        expect(send("agent:main:private")).toEqual([["chat"], [], []]);
        expect(send("agent:main:incognito")).toEqual([[], [], []]);
        expect(send("global")).toEqual([[], [], []]);
        expect(send(sessionKey, [sessionKey, "agent:main:private"])).toEqual([["chat"], [], []]);
        setUserProfileRole(shared.client.authenticatedUserProfile!.profileId, "none");
        prepareGatewayRecipientProfile(shared.client);
        expect(send(sessionKey)).toEqual([["chat"], [], []]);
      } finally {
        projection.dispose();
        connection.mentionInbox.dispose();
      }
    });
  });
});
