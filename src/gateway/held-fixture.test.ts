import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createGatewayHeldFixtureRunner } from "./held-fixture.test-support.js";

let finish: (() => Promise<void>) | undefined;
let releaseCheckpoint: (() => void) | undefined;
let probe: Promise<unknown> | undefined;
const privateOwners = createTempDirTracker();
afterEach(async () => {
  releaseCheckpoint?.();
  releaseCheckpoint = undefined;
  const current = finish;
  finish = undefined;
  await current?.();
  await probe;
  probe = undefined;
  vi.unstubAllEnvs();
  privateOwners.cleanup();
});

function createRunner() {
  // Deliberate cleanup failures retain private claims, not the enclosing runner's.
  const owner = createVitestResourceOwner(privateOwners.make("held-fixture-owner-"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, owner.root);
  const reports: Array<() => void> = [];
  const runner = createGatewayHeldFixtureRunner((report) => {
    reports.push(report);
    onTestFinished(report);
  });
  finish = runner.finishAfterEach;
  return { ...runner, reports, owner };
}

describe("held Gateway fixture ownership", () => {
  it("joins original tracked producers before disposal on normal completion", async () => {
    const runner = createRunner();
    const gate = createDeferred();
    const events: string[] = [];
    await runner.run(
      () => {
        events.push("release");
        gate.resolve();
      },
      async ({ signal, track }) => {
        signal.addEventListener("abort", () => events.push("abort"), { once: true });
        events.push("body");
        track(gate.promise.then(() => events.push("producer")));
      },
      async () => {
        events.push("dispose");
      },
    );
    await runner.finishAfterEach();
    await runner.finishAfterEach();
    expect(events).toEqual(["body", "abort", "release", "producer", "dispose"]);
    expect(runner.reports).toHaveLength(1);
    expect(runner.reports[0]).not.toThrow();
  });

  it("joins the whole scenario and producer when the hook overlaps body completion", async () => {
    const runner = createRunner();
    const entered = createDeferred();
    const bodyGate = createDeferred();
    const bodySettled = createDeferred();
    const producerGate = createDeferred();
    releaseCheckpoint = producerGate.resolve;
    const events: string[] = [];
    const outcome = Promise.allSettled([
      runner.run(
        () => {
          events.push("release");
          bodyGate.resolve();
        },
        async ({ signal, track }) => {
          signal.addEventListener("abort", () => events.push("abort"), { once: true });
          track(producerGate.promise.then(() => events.push("producer")));
          entered.resolve();
          await bodyGate.promise;
          events.push("body");
          bodySettled.resolve();
        },
        async () => {
          events.push("dispose");
        },
      ),
    ]);
    probe = outcome;
    await Promise.race([entered.promise, outcome]);
    const cleanup = runner.finishAfterEach().then(() => events.push("hook joined"));
    await Promise.race([bodySettled.promise, outcome]);
    // Let cleanup advance while the tracked producer is still held.
    await nextTurn();
    expect(events).toEqual(["abort", "release", "body"]);
    producerGate.resolve();
    await cleanup;
    expect(await outcome).toStrictEqual([{ status: "fulfilled", value: undefined }]);
    await runner.finishAfterEach();
    expect(events).toEqual(["abort", "release", "body", "producer", "dispose", "hook joined"]);
  });

  it.each([
    { label: "undefined", error: undefined },
    { label: "Error", error: new Error("release failure") },
  ])("joins held producers after release throws $label", async ({ error }) => {
    const runner = createRunner();
    const entered = createDeferred();
    const bodyGate = createDeferred();
    const bodySettled = createDeferred();
    const producerGate = createDeferred();
    releaseCheckpoint = producerGate.resolve;
    const events: string[] = [];
    const outcome = Promise.allSettled([
      runner.run(
        () => {
          events.push("release");
          bodyGate.resolve();
          throw error;
        },
        async ({ track }) => {
          track(producerGate.promise.then(() => events.push("producer")));
          entered.resolve();
          await bodyGate.promise;
          events.push("body");
          bodySettled.resolve();
        },
        async () => {
          events.push("dispose");
        },
      ),
    ]);
    probe = outcome;
    await Promise.race([entered.promise, outcome]);
    const cleanup = runner.finishAfterEach().then(() => events.push("hook joined"));
    await Promise.race([bodySettled.promise, outcome]);
    await nextTurn();
    expect(events).toEqual(["release", "body"]);
    expect(() => runner.owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    producerGate.resolve();
    await cleanup;
    const [result] = await outcome;
    expect(result).toStrictEqual({ status: "rejected", reason: error });
    if (result?.status !== "rejected") throw new Error("expected release failure");
    expect(result.reason).toBe(error);
    expect(events).toEqual(["release", "body", "producer", "dispose", "hook joined"]);
    await runner.finishAfterEach();
    expect(() => runner.owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    let reported: { error: unknown } | undefined;
    try {
      runner.reports[0]!();
    } catch (failure) {
      reported = { error: failure };
    }
    expect(reported).toStrictEqual({ error });
    expect(reported?.error).toBe(error);
    expect(runner.reports[0]).not.toThrow();
  });

  it("keeps the claim and hook pending until disposal settles", async () => {
    const runner = createRunner();
    const entered = createDeferred();
    const gate = createDeferred();
    releaseCheckpoint = gate.resolve;
    const dispose = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    let runJoined = false;
    let hookJoined = false;
    const outcome = Promise.allSettled([
      runner.run(
        () => {},
        async () => {},
        dispose,
      ),
    ]).then((results) => {
      runJoined = true;
      return results;
    });
    probe = outcome;
    await Promise.race([entered.promise, outcome]);
    const cleanup = runner.finishAfterEach().then(() => {
      hookJoined = true;
    });
    await nextTurn();
    expect(runJoined).toBe(false);
    expect(hookJoined).toBe(false);
    expect(() => runner.owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    gate.resolve();
    await cleanup;
    expect(await outcome).toStrictEqual([{ status: "fulfilled", value: undefined }]);
    expect(runJoined).toBe(true);
    expect(hookJoined).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => runner.owner.assertReleased()).not.toThrow();
    expect(runner.reports[0]).not.toThrow();
  });

  it("does not start a body retired before its scheduled invocation", async () => {
    const runner = createRunner();
    const body = vi.fn(async () => {});
    const release = vi.fn();
    const outcome = Promise.allSettled([runner.run(release, body)]);
    expect(() => runner.owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    await runner.finishAfterEach();
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: new Error("fixture is finishing") },
    ]);
    expect(body).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(() => runner.owner.assertReleased()).not.toThrow();
  });

  it.each([
    { phase: "body", label: "undefined", error: undefined },
    { phase: "body", label: "Error", error: new Error("body failure") },
    { phase: "dispose", label: "undefined", error: undefined },
    { phase: "dispose", label: "Error", error: new Error("disposal failure") },
  ] as const)("preserves a lone $phase rejection of $label", async ({ phase, error }) => {
    const runner = createRunner();
    const dispose = vi.fn(async () => {
      if (phase === "dispose") throw error;
    });
    const outcome = await Promise.allSettled([
      runner.run(
        () => {},
        async () => {
          if (phase === "body") throw error;
        },
        dispose,
      ),
    ]);
    expect(outcome).toStrictEqual([{ status: "rejected", reason: error }]);
    const [result] = outcome;
    if (result?.status !== "rejected") throw new Error("expected fixture failure");
    expect(result.reason).toBe(error);
    expect(dispose).toHaveBeenCalledOnce();
    await runner.finishAfterEach();
    await runner.finishAfterEach();
    if (phase === "dispose") {
      expect(() => runner.owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
    } else {
      expect(() => runner.owner.assertReleased()).not.toThrow();
    }
    expect(dispose).toHaveBeenCalledOnce();
    expect(runner.reports[0]).not.toThrow();
  });

  it.each([
    { label: "undefined primary", primary: undefined, cleanup: new Error("cleanup") },
    { label: "undefined cleanup", primary: new Error("primary"), cleanup: undefined },
  ])("retains primary-first failure and cause with $label", async ({ primary, cleanup }) => {
    const runner = createRunner();
    const [outcome] = await Promise.allSettled([
      runner.run(
        () => {},
        async () => {
          throw primary;
        },
        async () => {
          throw cleanup;
        },
      ),
    ]);
    expect(outcome?.status).toBe("rejected");
    if (outcome?.status !== "rejected") throw new Error("expected fixture failure");
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect(outcome.reason.errors).toStrictEqual([primary, cleanup]);
    expect(outcome.reason.errors[0]).toBe(primary);
    expect(outcome.reason.errors[1]).toBe(cleanup);
    expect(outcome.reason.cause).toBe(primary);
    expect(runner.reports[0]).not.toThrow();
  });

  it.each([false, true])(
    "preserves canonical drain failure before disposal failure (release fails=%s)",
    async (releaseFails) => {
      const runner = createRunner();
      const primary = new Error("scenario");
      const release = new Error("release");
      const drain = new Error("tracked cleanup");
      const dispose = new Error("disposal");
      const [outcome] = await Promise.allSettled([
        runner.run(
          () => {
            if (releaseFails) throw release;
          },
          async ({ track }) => {
            track(Promise.reject(drain), true);
            throw primary;
          },
          async () => {
            throw dispose;
          },
        ),
      ]);
      expect(outcome?.status).toBe("rejected");
      if (outcome?.status !== "rejected") throw new Error("expected fixture failure");
      const error: AggregateError = outcome.reason;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors[0]).toBe(primary);
      expect(error.cause).toBe(primary);
      const cleanup: AggregateError = error.errors[1];
      expect(cleanup).toBeInstanceOf(AggregateError);
      expect(cleanup.errors[0]).toBeInstanceOf(AggregateError);
      const drained: AggregateError = releaseFails
        ? cleanup.errors[0].errors[1]
        : cleanup.errors[0];
      if (releaseFails) {
        expect(cleanup.errors[0].errors[0]).toBe(release);
        expect(cleanup.errors[0].cause).toBe(release);
      }
      expect(drained).toBeInstanceOf(AggregateError);
      expect(drained.errors).toStrictEqual([drain]);
      expect(drained.errors[0]).toBe(drain);
      expect(cleanup.errors[1]).toBe(dispose);
      expect(cleanup.cause).toBe(cleanup.errors[0]);
      expect(() => runner.owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      expect(runner.reports[0]).not.toThrow();
    },
  );

  it("keeps hook joining fulfilled and reports cleanup only after reset", async () => {
    const runner = createRunner();
    const entered = createDeferred();
    const gate = createDeferred();
    const primary = new Error("scenario");
    const events: string[] = [];
    const outcome = Promise.allSettled([
      runner.run(
        gate.resolve,
        async () => {
          entered.resolve();
          await gate.promise;
          throw primary;
        },
        async () => {
          events.push("disposed");
          throw undefined;
        },
      ),
    ]);
    probe = outcome;
    await Promise.race([entered.promise, outcome]);
    await runner.finishAfterEach();
    events.push("reset");
    const [result] = await outcome;
    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") throw new Error("expected fixture failure");
    expect(result.reason.errors).toStrictEqual([primary, undefined]);
    // This injected hook probe tests the helper, not Vitest's hook scheduling.
    let failure: { error: unknown } | undefined;
    try {
      runner.reports[0]!();
    } catch (error) {
      events.push("reported");
      failure = { error };
    }
    expect(failure).toStrictEqual({ error: undefined });
    expect(events).toEqual(["disposed", "reset", "reported"]);
    expect(runner.reports[0]).not.toThrow();
  });

  it("preserves early producer rejection while waiting for readiness", async () => {
    const runner = createRunner();
    const neverReached = createDeferred();
    const failure = new Error("producer failed");
    const [outcome] = await Promise.allSettled([
      runner.run(
        () => {},
        async ({ signal, track }) => {
          const producer = track(Promise.reject(failure));
          await racePromiseWithAbortSignal(Promise.race([neverReached.promise, producer]), signal);
        },
      ),
    ]);
    expect(outcome).toStrictEqual({ status: "rejected", reason: failure });
    if (outcome?.status !== "rejected") throw new Error("expected producer failure");
    expect(outcome.reason).toBe(failure);
  });
});
