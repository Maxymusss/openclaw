import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { readSessionMethodAccess } from "./session-method-access.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  role?: string;
  includeAuth?: boolean;
  includeScopes?: boolean;
}): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  const connected = params.connected ?? true;
  return {
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    hello: {
      features: { methods: params.methods ?? ["sessions.create"] },
      ...(params.includeAuth === false
        ? {}
        : {
            auth: {
              role: params.role ?? "operator",
              ...(params.includeScopes === false
                ? {}
                : { scopes: params.scopes ?? ["operator.write"] }),
            },
          }),
    } as ApplicationGatewaySnapshot["hello"],
  };
}

describe("readSessionMethodAccess", () => {
  it.each([
    { method: "sessions.create", params: { agentId: "main", model: "fixture/allowed" } },
    { method: "sessions.patch", params: { key: "agent:main:own", model: "fixture/allowed" } },
  ])("admits the narrow alternative for $method", ({ method, params }) => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: [method], scopes: ["operator.sessions.write"] }),
        { method, params },
      ),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
  });

  it.each([
    { method: "sessions.create", params: { agentId: "main", incognito: true } },
    { method: "sessions.patch", params: { key: "agent:main:own", permissionMode: "full" } },
    { method: "sessions.delete", params: { key: "agent:main:own" } },
  ])("keeps the stronger policy for narrow $method", ({ method, params }) => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: [method], scopes: ["operator.sessions.write"] }),
        { method, params },
      ),
    ).toMatchObject({ allowed: false, requiredScope: "operator.admin" });
  });

  it.each(["sessions.reset", "sessions.patch"])(
    "preserves an explicit admin requirement on %s",
    (method) => {
      expect(
        readSessionMethodAccess(
          snapshot({
            methods: [method],
            scopes: ["operator.sessions.write", "operator.write"],
          }),
          {
            method,
            params: { key: "agent:main:own" },
            requiredScope: "operator.admin",
          },
        ),
      ).toMatchObject({ allowed: false, requiredScope: "operator.admin" });
      expect(
        readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.admin"] }), {
          method,
          params: { key: "agent:main:own" },
          requiredScope: "operator.admin",
        }),
      ).toEqual({ allowed: true, requiredScope: "operator.admin" });
    },
  );

  it("allows a write-scoped operator to create ordinary sessions", () => {
    expect(
      readSessionMethodAccess(snapshot({}), {
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
  });

  it("requires admin for privileged create params", () => {
    const access = readSessionMethodAccess(snapshot({ scopes: ["operator.write"] }), {
      method: "sessions.create",
      params: { agentId: "main", incognito: true },
    });
    expect(access.allowed).toBe(false);
    expect(access).toMatchObject({
      cause: "missing-scope",
      requiredScope: "operator.admin",
    });
  });

  it.each([
    ["sessions.dispatch", { key: "agent:main:device", deviceId: "runner" }],
    ["sessions.dispatch", { key: "agent:main:auto", autoDevice: true }],
    ["sessions.move", { key: "agent:main:device", target: { kind: "device", deviceId: "runner" } }],
  ])("allows write-scoped device placement through %s", (method, params) => {
    expect(
      readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.write"] }), {
        method,
        params,
        requiredScope: "operator.write",
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.write" });
  });

  it.each([
    ["sessions.dispatch", { key: "agent:main:cloud", profileId: "aws" }],
    ["sessions.move", { key: "agent:main:cloud", target: { kind: "profile", profileId: "aws" } }],
  ])("keeps profile placement admin-only through %s", (method, params) => {
    expect(
      readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.write"] }), {
        method,
        params,
        requiredScope: "operator.admin",
      }),
    ).toMatchObject({ allowed: false, requiredScope: "operator.admin" });
    expect(
      readSessionMethodAccess(snapshot({ methods: [method], scopes: ["operator.admin"] }), {
        method,
        params,
        requiredScope: "operator.admin",
      }),
    ).toEqual({ allowed: true, requiredScope: "operator.admin" });
  });

  it.each(["model", "thinkingLevel", "fastMode"])(
    "allows write-scoped %s changes while keeping read-only clients read-only",
    (field) => {
      for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
        expect(
          readSessionMethodAccess(snapshot({ methods: ["sessions.patch"], scopes: [scope] }), {
            method: "sessions.patch",
            params: { key: "agent:main:main", [field]: null },
          }),
        ).toMatchObject({ allowed: scope !== "operator.read", requiredScope: "operator.write" });
      }
    },
  );

  it("keeps context-window changes separate from write-scoped effort access", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["sessions.patch"], scopes: ["operator.write"] }),
        {
          method: "sessions.patch",
          params: { key: "agent:main:main", contextWindow: null },
        },
      ),
    ).toMatchObject({ allowed: false, cause: "missing-scope", requiredScope: "operator.admin" });
  });

  it("allows admin to satisfy write-scoped actions", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["sessions.groups.put"], scopes: ["operator.admin"] }),
        { method: "sessions.groups.put", requiredScope: "operator.write" },
      ).allowed,
    ).toBe(true);
  });

  it("allows broad and narrow session scopes to read sharing evidence", () => {
    for (const method of ["session.members.list", "session.members.listEvidence"]) {
      for (const scope of [
        "operator.read",
        "operator.write",
        "operator.admin",
        "operator.sessions.read",
        "operator.sessions.write",
      ]) {
        expect(
          readSessionMethodAccess(snapshot({ methods: [method], scopes: [scope] }), {
            method,
            requiredScope: "operator.read",
          }).allowed,
        ).toBe(true);
      }
    }
  });

  it.each([
    "session.visibility.set",
    "session.publicShare.set",
    "session.members.add",
    "session.members.remove",
  ])("does not let narrow sharing readers mutate through %s", (method) => {
    for (const scope of ["operator.sessions.read", "operator.sessions.write"]) {
      expect(
        readSessionMethodAccess(snapshot({ methods: [method], scopes: [scope] }), {
          method,
          requiredScope: "operator.write",
        }),
      ).toMatchObject({
        allowed: false,
        requiredScope: "operator.write",
        cause: "missing-scope",
      });
    }
  });

  it.each([
    { role: " operator ", scopes: [" operator.write "], allowed: true },
    { role: " operator ", scopes: [" operator.sessions.write "], allowed: true },
    { role: "node", scopes: ["operator.admin"], allowed: false },
    { role: "node", scopes: ["operator.sessions.write"], allowed: false },
  ])("keeps canonical role/scope normalization for $role $scopes", ({ role, scopes, allowed }) => {
    expect(
      readSessionMethodAccess(snapshot({ role, scopes }), { method: "sessions.create" }),
    ).toMatchObject({ allowed, requiredScope: "operator.write" });
  });

  it("rejects a read-scoped action without a compatible operator scope", () => {
    expect(
      readSessionMethodAccess(
        snapshot({ methods: ["session.members.listEvidence"], scopes: ["operator.approvals"] }),
        { method: "session.members.listEvidence", requiredScope: "operator.read" },
      ),
    ).toMatchObject({
      allowed: false,
      cause: "missing-scope",
      requiredScope: "operator.read",
    });
  });

  it.each([
    ["auth", { includeAuth: false }],
    ["scopes", { includeScopes: false }],
  ])("rejects snapshots without advertised %s", (_name, params) => {
    expect(
      readSessionMethodAccess(snapshot(params), {
        method: "sessions.create",
        params: { agentId: "main" },
      }),
    ).toMatchObject({ allowed: false, cause: "missing-scope" });
  });

  it("rejects disconnected and unadvertised calls before scope checks", () => {
    expect(
      readSessionMethodAccess(snapshot({ connected: false }), {
        method: "sessions.create",
      }),
    ).toMatchObject({ allowed: false, cause: "disconnected" });
    expect(
      readSessionMethodAccess(snapshot({ methods: [] }), { method: "sessions.create" }),
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
  });

  it("rejects snapshots without method metadata", () => {
    const incomplete = snapshot({});
    incomplete.hello = { auth: incomplete.hello?.auth } as ApplicationGatewaySnapshot["hello"];
    expect(
      readSessionMethodAccess(incomplete, {
        method: "sessions.groups.put",
        requiredScope: "operator.write",
      }),
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
  });

  it.each([
    {
      name: "absent snapshot",
      gateway: undefined,
      cause: "disconnected",
      reason: "sessionsView.actionRequiresConnection",
    },
    {
      name: "null snapshot",
      gateway: null,
      cause: "disconnected",
      reason: "sessionsView.actionRequiresConnection",
    },
    {
      name: "offline without method or auth",
      gateway: snapshot({ connected: false, methods: [], includeAuth: false }),
      cause: "disconnected",
      reason: "sessionsView.actionRequiresConnection",
    },
    {
      name: "connected phase without client, method or auth",
      gateway: { ...snapshot({ methods: [], includeAuth: false }), client: null },
      cause: "disconnected",
      reason: "sessionsView.actionRequiresConnection",
    },
    {
      name: "connected without method or auth",
      gateway: snapshot({ methods: [], includeAuth: false }),
      cause: "method-unavailable",
      reason: "sessionsView.actionUnavailable",
    },
    {
      name: "advertised without scopes",
      gateway: snapshot({ includeScopes: false }),
      cause: "missing-scope",
      reason: "sessionsView.actionRequiresWrite",
    },
  ] as const)("preserves denial precedence for $name", ({ gateway, cause, reason }) => {
    expect(readSessionMethodAccess(gateway, { method: "sessions.create" })).toEqual({
      allowed: false,
      requiredScope: "operator.write",
      cause,
      reason: t(reason),
    });
  });

  it.each([
    undefined,
    null,
    snapshot({ connected: false, methods: [], includeAuth: false }),
    snapshot({ methods: [], includeAuth: false }),
    snapshot({ methods: ["unknown.method"], scopes: ["operator.admin"] }),
  ])("requires a scope for an unknown method before checking snapshot %j", (gateway) => {
    expect(() => readSessionMethodAccess(gateway, { method: "unknown.method" })).toThrow(
      "Missing required scope for session mutation method: unknown.method",
    );
  });
});
