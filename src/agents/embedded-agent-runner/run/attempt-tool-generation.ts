import { randomUUID } from "node:crypto";
import { hasCommandProcessCleanupError } from "../../../process/exec-result.js";
import {
  runOutsideCommandProcessScope,
  withCommandProcessScope,
} from "../../../process/exec-spawn.js";
import { readAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { acquireExecScopeCleanup } from "../../bash-tools.exec-cleanup.js";
import { recordAgentCleanupFailure } from "../../run-cleanup-timeout.js";
import {
  NATIVE_SANDBOX_SETTLEMENT_MS,
  type NativeSandboxCustody,
} from "../../sandbox/container-engine.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** The existing tool generation also owns allocation that precedes tool preparation. */
export function createEmbeddedAttemptToolGenerationOwner(
  attempt: Pick<EmbeddedRunAttemptParams, "runId" | "admittedRunContext">,
  signal: AbortSignal | undefined,
) {
  const operatorAuthority = readAdmittedRunOperatorAuthority(attempt.admittedRunContext);
  const foregroundOnly = operatorAuthority?.executionPolicy === "foreground-only";
  const retiring = new Set<Promise<void>>();
  let failure: { error: unknown } | undefined;
  const assertCleanupConfirmed = () => {
    if (failure) {
      recordAgentCleanupFailure();
      throw failure.error;
    }
  };
  const create = () => {
    const controller = new AbortController();
    const signals = [controller.signal];
    if (signal) {
      signals.push(signal);
    }
    if (foregroundOnly && operatorAuthority?.signal) {
      signals.push(operatorAuthority.signal);
    }
    const abortSignal = AbortSignal.any(signals);
    const scopeKey = foregroundOnly ? `foreground:${attempt.runId}:${randomUUID()}` : undefined;
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    const nativeCleanups: typeof cleanups = [];
    const producers = new Set<Promise<unknown>>();
    let closing: Promise<void> | undefined;
    let closed = false;
    const assertCurrent = () => {
      operatorAuthority?.assertCurrent();
      if (foregroundOnly) {
        abortSignal.throwIfAborted();
      }
    };
    const registerCleanup = (cleanup: (reason: string) => Promise<void>) => {
      if (foregroundOnly) {
        assertCurrent();
      }
      cleanups.push(cleanup);
    };
    if (scopeKey) {
      cleanups.push(acquireExecScopeCleanup(scopeKey, "required-all"));
    }
    const nativeCustody: NativeSandboxCustody | undefined = scopeKey
      ? {
          runtimeKey: scopeKey,
          signal: abortSignal,
          assertCurrent,
          assertCleanupConfirmed,
          registerCleanup(cleanup) {
            assertCurrent();
            nativeCleanups.push(cleanup);
          },
          runProducer(run, options) {
            // Register before dispatch, then escape only into this native owner's
            // scope. Stop closes exposure without losing a late engine receipt.
            const pending = Promise.resolve().then(() => {
              assertCurrent();
              const deadlineAt = operatorAuthority?.foregroundDeadlineAt;
              const executionSignal = options?.settleAfterAbort
                ? AbortSignal.timeout(NATIVE_SANDBOX_SETTLEMENT_MS)
                : deadlineAt === undefined
                  ? abortSignal
                  : AbortSignal.any([
                      abortSignal,
                      AbortSignal.timeout(Math.max(0, Math.ceil(deadlineAt - Date.now()))),
                    ]);
              return runOutsideCommandProcessScope(() =>
                withCommandProcessScope(run, executionSignal),
              );
            });
            producers.add(pending);
            void pending.then(
              () => producers.delete(pending),
              (error: unknown) => {
                if (hasCommandProcessCleanupError(error)) {
                  failure ??= { error };
                }
                producers.delete(pending);
              },
            );
            return pending;
          },
        }
      : undefined;
    return {
      signal: abortSignal,
      scopeKey,
      nativeCustody,
      assertCurrent,
      registerCleanup,
      abort(reason?: unknown) {
        controller.abort(reason);
      },
      close(reason: string) {
        controller.abort();
        return (closing ??= (async () => {
          if (producers.size > 0) {
            await Promise.allSettled(producers);
          }
          // Local CLI cleanup must settle before native retirement may forget
          // its reservation. A later namespace success cannot erase that uncertainty.
          for (const pending of [cleanups, nativeCleanups]) {
            const results = await Promise.allSettled(
              pending.splice(0).map(async (cleanup) => await cleanup(reason)),
            );
            const rejected = results.find((result) => result.status === "rejected");
            if (rejected) {
              failure ??= { error: rejected.reason };
            }
          }
          closed = true;
        })());
      },
      get closed() {
        return closed;
      },
    };
  };
  let current = create();
  const retire = (reason: string) => {
    const settled = current.close(reason);
    retiring.add(settled);
    void settled.then(() => retiring.delete(settled));
    return settled;
  };
  return {
    foregroundOnly,
    operatorAuthority,
    get current() {
      return current;
    },
    retire,
    assertCleanupConfirmed,
    replace() {
      if (foregroundOnly && (!current.closed || failure)) {
        throw new Error("Foreground tool replacement requires confirmed cleanup.");
      }
      current = create();
      return current;
    },
    async release(reason: string) {
      void retire(reason);
      await Promise.all(retiring);
      if (failure) {
        recordAgentCleanupFailure();
      }
    },
  };
}

export type EmbeddedAttemptToolGenerationOwner = ReturnType<
  typeof createEmbeddedAttemptToolGenerationOwner
>;
