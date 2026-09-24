import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  resetAllLanes,
  setCommandLaneConcurrency,
  tryAcquireHeartbeatAdmission,
} from "./command-queue.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diagnosticLogger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function resetQueue() {
  resetAllLanes();
  resetCommandQueueStateForTest();
}

describe("heartbeat command-lane admission", () => {
  beforeEach(resetQueue);
  afterEach(resetQueue);

  it.each([
    ["session", "session:agent:Ops:queued-session"],
    ["nested", "nested:agent:Ops:queued-nested"],
  ] as const)(
    "rejects an Ops heartbeat while %s work is queued at concurrency zero",
    async (_label, lane) => {
      setCommandLaneConcurrency(lane, 0);
      const queued = enqueueCommandInLane(lane, async () => "finished");

      expect(getCommandLaneSnapshot(lane)).toMatchObject({ queuedCount: 1, activeCount: 0 });
      expect(tryAcquireHeartbeatAdmission("OPS")).toBeUndefined();
      const unrelatedAdmission = tryAcquireHeartbeatAdmission("research");
      expect(unrelatedAdmission).toBeTypeOf("function");
      unrelatedAdmission?.();

      setCommandLaneConcurrency(lane, 1);
      await expect(queued).resolves.toBe("finished");
    },
  );

  it("rejects an Ops heartbeat while a matching scoped lane is active", async () => {
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    const active = enqueueCommandInLane("session:agent:ops:active-session", async () => {
      started.resolve();
      await finish.promise;
      return "finished";
    });
    await started.promise;

    expect(getCommandLaneSnapshot("session:agent:ops:active-session")).toMatchObject({
      queuedCount: 0,
      activeCount: 1,
    });
    expect(tryAcquireHeartbeatAdmission("ops")).toBeUndefined();

    finish.resolve();
    await expect(active).resolves.toBe("finished");
  });

  it("serializes heartbeat admissions by normalized agent and releases idempotently", () => {
    const release = tryAcquireHeartbeatAdmission(" OPS ");
    expect(release).toBeTypeOf("function");
    expect(tryAcquireHeartbeatAdmission("ops")).toBeUndefined();

    release?.();
    release?.();
    const nextAdmission = tryAcquireHeartbeatAdmission("Ops");
    expect(nextAdmission).toBeTypeOf("function");
    nextAdmission?.();
  });

  it("clears reservations on lane reset without letting stale releases clear a new owner", () => {
    const staleRelease = tryAcquireHeartbeatAdmission("ops");
    expect(staleRelease).toBeTypeOf("function");

    resetAllLanes();
    const currentRelease = tryAcquireHeartbeatAdmission("ops");
    expect(currentRelease).toBeTypeOf("function");
    staleRelease?.();
    expect(tryAcquireHeartbeatAdmission("ops")).toBeUndefined();

    currentRelease?.();
    expect(tryAcquireHeartbeatAdmission("ops")).toBeTypeOf("function");
  });

  it("keeps ordinary queue arrivals admissible while a heartbeat owns its reservation", async () => {
    const releaseAdmission = tryAcquireHeartbeatAdmission("ops");
    expect(releaseAdmission).toBeTypeOf("function");
    const lane = "session:agent:ops:later-arrival";
    setCommandLaneConcurrency(lane, 0);
    const laterWork = enqueueCommandInLane(lane, async () => "finished");
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ queuedCount: 1, activeCount: 0 });

    releaseAdmission?.();
    setCommandLaneConcurrency(lane, 1);
    await expect(laterWork).resolves.toBe("finished");
  });
});
