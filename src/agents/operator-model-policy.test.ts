import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { bindOperatorModelExecution } from "./admitted-run-context.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-operator-authority.js";
import {
  prepareOperatorModelPolicy,
  resolveOperatorModelDefault,
  assertOperatorModelAllowed,
  assertOperatorModelResponse,
  guardOperatorModelProviderStream,
  OperatorModelPolicyError,
  runWithOperatorModelAuthority,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import type { StreamFn } from "./runtime/index.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("operator model request lifetime", () => {
  it.each([
    {
      first: ["operator.admin"],
      second: ["operator.sessions.write"],
      expected: ["operator.sessions.write"],
    },
    {
      first: ["operator.read"],
      second: ["operator.sessions.write"],
      expected: ["operator.sessions.read"],
    },
  ])(
    "preserves canonical scope implications for $first and $second",
    ({ first, second, expected }) => {
      const a = createAdmittedRunOperatorAuthority({
        profileId: "same-person",
        scopes: first,
        assertCurrent() {},
      });
      const b = createAdmittedRunOperatorAuthority({ ...a, scopes: second });
      runWithOperatorModelRequest(a, () =>
        runWithOperatorModelRequest(b, (combined) => {
          expect(combined?.scopes).toEqual(expected);
        }),
      );
    },
  );

  it("intersects compatible A → B → A captures and retains each until owned cleanup drains", async () => {
    const source = {};
    const signals = [new AbortController(), new AbortController()];
    const releases = [vi.fn(), vi.fn()];
    const retainA = vi.fn(() => releases[0]!);
    const retainB = vi.fn(() => releases[1]!);
    const deadline = Date.now() + 60_000;
    const a = createAdmittedRunOperatorAuthority({
      profileId: "same-person",
      source,
      scopes: ["operator.read", "operator.write"],
      permissions: { models: { allow: ["fixture/shared", "fixture/only-a"] } },
      gatewayAccessGrant: { pluginId: "fixture", grantId: "original" },
      executionPolicy: "foreground-only",
      foregroundRunId: "original-turn",
      foregroundDeadlineAt: deadline,
      signal: signals[0]!.signal,
      assertCurrent() {},
      retain: retainA,
    });
    const b = createAdmittedRunOperatorAuthority({
      ...a,
      scopes: ["operator.read"],
      permissions: { models: { allow: ["fixture/shared", "fixture/only-b"] } },
      gatewayAccessGrant: { pluginId: "fixture", grantId: "original" },
      foregroundDeadlineAt: deadline - 1_000,
      signal: signals[1]!.signal,
      assertCurrent() {},
      retain: retainB,
    });
    const finish = createDeferredCore();
    const owner = new AsyncWorkScope();
    const result = owner.run(() =>
      runWithOperatorModelRequest(a, () =>
        runWithOperatorModelRequest(b, (combined) => {
          expect(combined?.permissions).toEqual({ models: { allow: ["fixture/shared"] } });
          expect(combined?.scopes).toEqual(["operator.read"]);
          expect(combined?.foregroundDeadlineAt).toBe(deadline - 1_000);
          expect(combined?.executionPolicy).toBe("foreground-only");
          expect(combined?.signal).not.toBe(a.signal);
          expect(combined?.signal).not.toBe(b.signal);
          expect(() => assertOperatorModelAllowed(a, "fixture", "only-a")).toThrow(
            OperatorModelPolicyError,
          );
          expect(() => assertOperatorModelAllowed(b, "fixture", "only-b")).toThrow(
            OperatorModelPolicyError,
          );
          assertOperatorModelAllowed(a, "fixture", "shared");
          return runWithOperatorModelRequest(a, (nested) => {
            expect(nested).toBe(combined);
            return runWithOperatorModelAuthority(b, async (held) => {
              expect(held).toBe(combined);
              void trackAsyncWork(() => finish.promise);
              return "accepted";
            });
          });
        }),
      ),
    );
    try {
      expect(await result).toBe("accepted");
      expect(retainA).toHaveBeenCalledOnce();
      expect(retainB).toHaveBeenCalledOnce();
      for (const release of releases) {
        expect(release).not.toHaveBeenCalled();
      }
    } finally {
      finish.resolve();
      await owner.drain();
    }
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it.each(["source", "profile", "grant", "unclassified-grant", "turn"] as const)(
    "rejects an incompatible %s before entering a nested request",
    (mismatch) => {
      const a = createAdmittedRunOperatorAuthority({
        profileId: "original-person",
        source: {},
        scopes: ["operator.read"],
        gatewayAccessGrant:
          mismatch === "unclassified-grant" ? null : { pluginId: "fixture", grantId: "original" },
        executionPolicy: "foreground-only",
        foregroundRunId: "original-turn",
        foregroundDeadlineAt: Date.now() + 60_000,
        assertCurrent() {},
      });
      const changes: Partial<AdmittedRunOperatorAuthority> =
        mismatch === "source"
          ? { source: {} }
          : mismatch === "profile"
            ? { profileId: "another-person" }
            : mismatch === "grant"
              ? { gatewayAccessGrant: { pluginId: "fixture", grantId: "replacement" } }
              : mismatch === "unclassified-grant"
                ? { gatewayAccessGrant: undefined }
                : { foregroundRunId: "another-turn" };
      const b = createAdmittedRunOperatorAuthority({ ...a, ...changes });
      const run = vi.fn();
      expect(() =>
        runWithOperatorModelRequest(a, () => runWithOperatorModelRequest(b, run)),
      ).toThrow(OperatorModelPolicyError);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("keeps every composite logical policy live and joins selected-model subscriptions", () => {
    const cfg = { agents: { defaults: { model: "fixture/shared" } } };
    const policy = (allow: string[]) =>
      prepareOperatorModelPolicy({
        cfg,
        policy: { allow },
        manifestPlugins: [],
      });
    let firstPolicy = policy(["fixture/shared", "fixture/only-a"]);
    let secondPolicy = policy(["fixture/shared", "fixture/only-b"]);
    const listeners = [new Set<() => void>(), new Set<() => void>()] as const;
    const released = [vi.fn(), vi.fn()] as const;
    const unsubscribe = [vi.fn(), vi.fn()] as const;
    const source = {};
    const capture = (index: 0 | 1) =>
      createAdmittedRunOperatorAuthority({
        source,
        profileId: "same-person",
        scopes: ["operator.read"],
        assertCurrent() {},
        retain: () => released[index],
        get modelPolicy() {
          return index === 0 ? firstPolicy : secondPolicy;
        },
        onModelPolicyChanged: (listener) => {
          listeners[index].add(listener);
          return () => {
            listeners[index].delete(listener);
            unsubscribe[index]();
          };
        },
      });
    const a = capture(0);
    const b = capture(1);
    runWithOperatorModelRequest(a, () =>
      runWithOperatorModelRequest(b, (combined) => {
        expect(combined?.modelPolicy?.models).toEqual([{ provider: "fixture", model: "shared" }]);
        runWithOperatorModelRequest(a, (again) => expect(again).toBe(combined));
        const execution = bindOperatorModelExecution(combined, {
          provider: "fixture",
          model: "shared",
        });
        expect(execution).toBeDefined();
        try {
          firstPolicy = policy(["fixture/shared", "fixture/only-b"]);
          for (const listener of listeners[0]) {
            listener();
          }
          expect(execution?.signal.aborted).toBe(false);
          expect(combined?.modelPolicy?.allows({ provider: "fixture", model: "only-b" })).toBe(
            true,
          );
          secondPolicy = policy(["fixture/only-b"]);
          for (const listener of listeners[1]) {
            listener();
          }
          expect(execution?.signal.aborted).toBe(true);
          expect(execution?.assertCurrent).toThrow("operator role cannot use this model");
          expect(combined?.modelPolicy?.models).toEqual([{ provider: "fixture", model: "only-b" }]);
        } finally {
          execution?.release();
        }
      }),
    );
    for (const set of listeners) {
      expect(set.size).toBe(0);
    }
    for (const close of [...released, ...unsubscribe]) {
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("rolls back acquired captures when a later retain fails", async () => {
    const source = {};
    const release = vi.fn();
    const retain = vi.fn(() => release);
    const a = createAdmittedRunOperatorAuthority({
      profileId: "same-person",
      source,
      scopes: ["operator.read"],
      assertCurrent() {},
      retain,
    });
    const failure = new Error("second source could not be retained");
    const secondRetain = vi.fn(() => {
      throw failure;
    });
    const b = createAdmittedRunOperatorAuthority({ ...a, retain: secondRetain });
    const run = vi.fn(async () => "must not run");
    const owner = new AsyncWorkScope();
    await expect(
      owner.run(() => runWithOperatorModelRequest(a, () => runWithOperatorModelAuthority(b, run))),
    ).rejects.toBe(failure);
    await owner.drain();
    expect(retain).toHaveBeenCalledOnce();
    expect(secondRetain).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["first", "second"] as const)("keeps the %s source abort in its composition", (which) => {
    const source = {};
    const first = new AbortController();
    const second = new AbortController();
    const a = createAdmittedRunOperatorAuthority({
      profileId: "same-person",
      source,
      scopes: [],
      assertCurrent() {},
      signal: first.signal,
    });
    const b = createAdmittedRunOperatorAuthority({ ...a, signal: second.signal });
    const combined = runWithOperatorModelRequest(a, () =>
      runWithOperatorModelRequest(b, (value) => value),
    );
    const reason = new Error("original source revoked");
    (which === "first" ? first : second).abort(reason);
    expect(combined?.signal?.reason).toBe(reason);
    expect(() => runWithOperatorModelRequest(combined, () => {})).toThrow(
      "original source revoked",
    );
  });

  it("retains its original source until accepted asynchronous work drains", async () => {
    const owner = new AsyncWorkScope();
    const finish = createDeferredCore();
    const release = vi.fn();
    const retain = vi.fn(() => release);
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "original-person",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow: [] } },
      assertCurrent: () => {},
      retain,
    });
    const result = owner.run(() =>
      runWithOperatorModelRequest(authority, () =>
        runWithOperatorModelAuthority(undefined, async () => {
          void trackAsyncWork(() => finish.promise);
          return "accepted";
        }),
      ),
    );
    try {
      expect(await result).toBe("accepted");
      expect(retain).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(owner.hasPendingWork).toBe(true);
    } finally {
      finish.resolve();
      await owner.drain();
    }
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps the enclosing authority when a nested invocation omits it", async () => {
    const model = makeProviderModelFixture({
      api: "fixture",
      provider: "fixture",
      id: "selected",
      baseUrl: "https://provider.example/v1",
    });
    const raw = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    const cached = guardOperatorModelProviderStream(raw);
    const original = createAdmittedRunOperatorAuthority({
      profileId: "original-person",
      scopes: ["operator.sessions.write"],
      permissions: { models: { allow: [] } },
      assertCurrent: () => {},
    });
    await runWithOperatorModelRequest(original, async () => {
      await runWithOperatorModelRequest(undefined, async () => {
        await Promise.resolve();
        expect(() => cached(model, { messages: [] })).toThrow(OperatorModelPolicyError);
      });
      expect(() => cached(model, { messages: [] })).toThrow(OperatorModelPolicyError);
    });
    expect(raw).not.toHaveBeenCalled();
    await cached(model, { messages: [] });
    expect(raw).toHaveBeenCalledOnce();
  });

  it("does not interpret a stale error code on successful output as a denial", () => {
    expect(() =>
      assertOperatorModelResponse({
        stopReason: "stop",
        errorCode: "OPERATOR_MODEL_POLICY_DENIED",
      }),
    ).not.toThrow();
  });
});

function config(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        systemAgent: { agentId: "shared" },
        model: "vendor/global",
        models: { "vendor/unrelated": { alias: "fast" } },
      },
      entries: {
        shared: {
          model: {
            primary: "vendor/primary",
            fallbacks: ["fast", "vendor/restricted-v1", "vendor/fallback"],
          },
          models: { "vendor/fallback": { alias: "fast" } },
        },
        other: { model: "vendor/other" },
      },
    },
  };
}

describe("operator model policy", () => {
  it("derives ordered choices from the designated agent and resolves its aliases before exclusions", () => {
    const cfg = config();
    const policy = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["vendor/restricted-*"] },
      manifestPlugins: [],
    })!;
    expect(policy.models).toEqual([
      { provider: "vendor", model: "primary" },
      { provider: "vendor", model: "fallback" },
    ]);
    expect(policy.allows({ provider: "vendor", model: "unrelated" })).toBe(false);
    expect(policy.allows({ provider: "vendor", model: "global" })).toBe(false);
    expect(policy.allows({ provider: "vendor", model: "restricted-v1" })).toBe(false);
    expect(policy.allows({ provider: "vendor", model: "vendor/primary" })).toBe(false);

    const deniedAlias = prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "shared", deny: ["fast"] },
      manifestPlugins: [],
    })!;
    expect(deniedAlias.allows({ provider: "vendor", model: "fallback" })).toBe(false);
  });

  it("keeps family exclusions effective when the referenced source adds new models", () => {
    const cfg = config();
    cfg.agents!.entries!.shared!.model = {
      primary: "vendor/restricted-next",
      fallbacks: ["vendor/fallback", "vendor/new-allowed"],
    };
    const after = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["vendor/restricted-*"] },
      manifestPlugins: [],
    })!;
    expect(after.models).toEqual([
      { provider: "vendor", model: "fallback" },
      { provider: "vendor", model: "new-allowed" },
    ]);
    expect(after.allows({ provider: "vendor", model: "restricted-next" })).toBe(false);
  });

  it("supports explicit membership and provider-normalized exclusions without widening empty policies", () => {
    const cfg = config();
    const policy = prepareOperatorModelPolicy({
      cfg,
      policy: { allow: ["vendor/*", "second/manual"], deny: [" VENDOR / restricted-* "] },
      manifestPlugins: [],
    })!;
    expect(policy.allows({ provider: "VENDOR", model: "new" })).toBe(true);
    expect(policy.allows({ provider: "vendor", model: "restricted-new" })).toBe(false);
    expect(policy.allows({ provider: "second", model: "manual" })).toBe(true);
    expect(policy.allows({ provider: "second", model: "other" })).toBe(false);
    expect(
      prepareOperatorModelPolicy({ cfg, policy: undefined, manifestPlugins: [] }),
    ).toBeUndefined();
    const empty = prepareOperatorModelPolicy({ cfg, policy: { allow: [] }, manifestPlugins: [] })!;
    expect(empty.models).toEqual([]);
    expect(empty.allows({ provider: "vendor", model: "primary" })).toBe(false);
  });

  it("replaces a denied default with an existing automatic fallback without granting a manual override", () => {
    const cfg = config();
    const policy = prepareOperatorModelPolicy({
      cfg,
      policy: { deny: ["vendor/primary", "vendor/restricted-*"] },
      manifestPlugins: [],
    });
    expect(
      resolveOperatorModelDefault({
        cfg,
        agentId: "shared",
        policy,
        model: { provider: "vendor", model: "primary" },
        allows: () => false,
        manifestPlugins: [],
      }),
    ).toEqual({ provider: "vendor", model: "fallback" });
    expect(
      resolveOperatorModelDefault({
        cfg,
        agentId: "other",
        policy,
        model: { provider: "vendor", model: "other" },
        allows: () => false,
        manifestPlugins: [],
      }),
    ).toBeUndefined();
  });
});
