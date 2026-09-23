import { describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "../agents/admitted-run-context.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { withOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
import { AsyncWorkScope, captureAsyncWorkTracker } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runWithDecisionOperatorAuthority } from "./operator-authority.js";

function withSystemCaller<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  return enabled
    ? withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:decision-system",
          operationalRunInstance: createOperationalRunInstanceRef("decision-system"),
          receiptAuthority: () => true,
        },
        run,
      )
    : run();
}

describe("Decision direct-tool admission", () => {
  it.each(
    (["model", "foreground", "unbound", "revoked", "expired"] as const).flatMap((state) =>
      [false, true].map((nestedSystem) => ({ state, nestedSystem })),
    ),
  )(
    "rejects $state before the lazy callback with nested system=$nestedSystem",
    async ({ state, nestedSystem }) => {
      const owner = new AsyncWorkScope();
      const lazy = vi.fn(async () => "not admitted");
      const source = createAdmittedRunOperatorAuthority({
        profileId: "decision-reader",
        scopes: ["operator.write"],
        assertCurrent: () => {},
        ...(state === "model"
          ? {
              modelPolicy: prepareOperatorModelPolicy({
                cfg: {},
                policy: { allow: ["fixture/fixture-v1"] },
                manifestPlugins: [],
              }),
            }
          : {}),
        ...(state === "foreground" || state === "expired"
          ? { executionPolicy: "foreground-only" as const }
          : {}),
        ...(state === "expired"
          ? { foregroundRunId: "expired", foregroundDeadlineAt: Date.now() - 1 }
          : {}),
        ...(state === "revoked"
          ? { signal: AbortSignal.abort(new Error("original source revoked")) }
          : {}),
      });
      try {
        await expect(
          owner.run(() =>
            withOperatorToolGatewayAuthority(
              {
                scopes: ["operator.write"],
                operatorRoleActor: { kind: "operator", profileId: source.profileId },
                ...(state === "unbound" ? {} : { operatorRunAuthority: source }),
              },
              () => withSystemCaller(nestedSystem, () => runWithDecisionOperatorAuthority(lazy)),
            ),
          ),
        ).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
        expect(lazy).not.toHaveBeenCalled();
      } finally {
        await owner.drain();
      }
    },
  );

  it.each(
    (["current", "invocation-retired", "source-revoked"] as const).flatMap((state) =>
      [false, true].map((nestedSystem) => ({ state, nestedSystem })),
    ),
  )(
    "keeps the $state fence and cleanup hold with nested system=$nestedSystem",
    async ({ state, nestedSystem }) => {
      const owner = new AsyncWorkScope();
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const cleanup = createDeferredCore();
      const release = vi.fn();
      const retain = vi.fn(() => release);
      const cancellation = new AbortController();
      const source = createAdmittedRunOperatorAuthority({
        profileId: "decision-staff",
        scopes: ["operator.admin"],
        signal: cancellation.signal,
        assertCurrent: () => {},
        retain,
      });
      let pending: Promise<string> | undefined;
      let cleanupWork: Promise<void> | undefined;
      const invocation = owner.run(() =>
        withOperatorToolGatewayAuthority(
          { scopes: source.scopes, operatorRunAuthority: source },
          async () => {
            pending = withSystemCaller(nestedSystem, () =>
              runWithDecisionOperatorAuthority(async () => {
                cleanupWork = captureAsyncWorkTracker()(() => cleanup.promise);
                entered.resolve();
                await finish.promise;
                return "completed";
              }),
            );
            if (state === "invocation-retired") {
              await entered.promise;
              return;
            }
            return await pending;
          },
        ),
      );
      try {
        await Promise.race([entered.promise, invocation]);
        if (!pending || !cleanupWork) {
          throw new Error("Decision callback did not acquire its work");
        }
        expect(retain).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        if (state === "invocation-retired") {
          await invocation;
          expect(() => source.assertCurrent()).not.toThrow();
        } else if (state === "source-revoked") {
          cancellation.abort(new Error("original source revoked"));
        }
        const result = state === "invocation-retired" ? pending : invocation;
        const settled =
          state === "current"
            ? expect(result).resolves.toBe("completed")
            : expect(result).rejects.toMatchObject({ code: "OPERATOR_MODEL_POLICY_DENIED" });
        finish.resolve();
        await settled;
        expect(release).not.toHaveBeenCalled();
        cleanup.resolve();
        await cleanupWork;
        await AsyncWorkScope.runWhenAllIdle(
          () => [owner],
          () => {
            expect(release).toHaveBeenCalledOnce();
          },
        );
      } finally {
        finish.resolve();
        cleanup.resolve();
        await Promise.allSettled([invocation, pending, cleanupWork]);
        await owner.drain();
      }
    },
  );
});
