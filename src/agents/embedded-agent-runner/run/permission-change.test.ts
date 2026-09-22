import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  createEmbeddedRunPermissionChanges,
  prepareEmbeddedPermissionPublication,
  withAuthorizedPermissionChange,
} from "./permission-change.js";

function fixture() {
  const params: Pick<RunEmbeddedAgentParams, "execOverrides" | "permissionMode"> = {
    permissionMode: "workspace",
    execOverrides: { mode: "auto" },
  };
  const owner = createEmbeddedRunPermissionChanges(params);
  const attempt = owner.forAttempt();
  const publish = vi.fn();
  const source = new AbortController();
  const run = new AbortController();
  const deadlineAt = Date.now() + 60_000;
  const publication = {
    operatorAuthority: createAdmittedRunOperatorAuthority({
      profileId: "foreground-permission-person",
      scopes: ["operator.sessions.write"],
      executionPolicy: "foreground-only",
      foregroundDeadlineAt: deadlineAt,
      foregroundRunId: "foreground-permission-run",
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
    }),
    runAbortSignal: run.signal,
    assertActiveRun: vi.fn(),
    publish,
  };
  const complete = withAuthorizedPermissionChange(attempt.owner, "full", () =>
    prepareEmbeddedPermissionPublication(attempt, "full", publication),
  );
  return { params, owner, attempt, publish, complete, publication, source, run, deadlineAt };
}

it("completes only the captured publication after cleanup without retaining ambient authorization", async () => {
  const state = fixture();
  const cleanup = createDeferred();
  const completion = cleanup.promise.then(state.complete);
  try {
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.params.permissionMode).toBe("workspace");
    expect(() => state.attempt.recordApplied("full")).toThrow("not authorized");
    expect(() => state.attempt.request("full")).toThrow("not authorized");
    cleanup.resolve();
    await completion;
    expect(state.publish).toHaveBeenCalledOnce();
    expect(state.params).toEqual({ permissionMode: "full", execOverrides: { mode: "full" } });
    expect(() => state.complete()).toThrow("no longer current");
    expect(state.publish).toHaveBeenCalledOnce();
  } finally {
    cleanup.resolve();
    await completion;
    state.owner.close();
  }
});

it.each(["request", "receipt", "record", "attempt", "close"] as const)(
  "invalidates older unfinished publication at newer accepted %s",
  async (replacement) => {
    const state = fixture();
    const nextPublish = vi.fn();
    let nextComplete: (() => void) | undefined;
    let pendingRequest: Promise<boolean> | undefined;
    try {
      if (replacement === "request") {
        pendingRequest = withAuthorizedPermissionChange(state.attempt.owner, "read-only", () =>
          state.attempt.request("read-only"),
        );
      } else if (replacement === "receipt") {
        nextComplete = withAuthorizedPermissionChange(state.attempt.owner, "read-only", () =>
          prepareEmbeddedPermissionPublication(state.attempt, "read-only", {
            ...state.publication,
            publish: nextPublish,
          }),
        );
      } else if (replacement === "record") {
        withAuthorizedPermissionChange(state.attempt.owner, "read-only", () =>
          state.attempt.recordApplied("read-only"),
        );
      } else if (replacement === "attempt") {
        const nextAttempt = state.owner.forAttempt();
        expect(nextAttempt.owner).toBe(state.attempt.owner);
        expect(nextAttempt).not.toBe(state.attempt);
      } else {
        state.owner.close();
      }
      expect(() => state.complete()).toThrow("no longer current");
      expect(state.publish).not.toHaveBeenCalled();
      expect(nextPublish).not.toHaveBeenCalled();
      expect(state.params.permissionMode).toBe(
        replacement === "record" ? "read-only" : "workspace",
      );
      nextComplete?.();
      if (nextComplete) {
        expect(nextPublish).toHaveBeenCalledOnce();
        expect(state.params.permissionMode).toBe("read-only");
      }
    } finally {
      state.owner.close();
      if (pendingRequest) {
        await expect(pendingRequest).resolves.toBe(false);
      }
    }
  },
);

it("consumes a failed publication without updating permissions or permitting retry", () => {
  const state = fixture();
  const failure = new Error("tool publication failed");
  const publish = vi.fn(() => {
    throw failure;
  });
  try {
    const complete = withAuthorizedPermissionChange(state.attempt.owner, "full", () =>
      prepareEmbeddedPermissionPublication(state.attempt, "full", {
        ...state.publication,
        publish,
      }),
    );
    expect(() => complete()).toThrow(failure);
    expect(state.params.permissionMode).toBe("workspace");
    expect(() => complete()).toThrow("already consumed");
    expect(publish).toHaveBeenCalledOnce();
  } finally {
    state.owner.close();
  }
});

it("rejects forged, widened and post-await publication capture", async () => {
  const state = fixture();
  try {
    expect(() =>
      prepareEmbeddedPermissionPublication(state.attempt, "full", state.publication),
    ).toThrow("not authorized");
    withAuthorizedPermissionChange(state.attempt.owner, "read-only", () => {
      expect(() =>
        prepareEmbeddedPermissionPublication(state.attempt, "full", state.publication),
      ).toThrow("not authorized");
      expect(() =>
        prepareEmbeddedPermissionPublication({ ...state.attempt }, "read-only", state.publication),
      ).toThrow("attempt is no longer active");
    });
    await expect(
      withAuthorizedPermissionChange(state.attempt.owner, "full", async () => {
        await Promise.resolve();
        return prepareEmbeddedPermissionPublication(state.attempt, "full", state.publication);
      }),
    ).rejects.toThrow("not authorized");
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.params.permissionMode).toBe("workspace");
  } finally {
    state.owner.close();
  }
});

it("preserves same-pending dedupe and replacement-attempt acknowledgement", async () => {
  const state = fixture();
  try {
    const first = withAuthorizedPermissionChange(state.attempt.owner, "full", () =>
      state.attempt.request("full"),
    );
    const between = withAuthorizedPermissionChange(state.attempt.owner, "full", () =>
      prepareEmbeddedPermissionPublication(state.attempt, "full", state.publication),
    );
    const repeated = withAuthorizedPermissionChange(state.attempt.owner, "full", () =>
      state.attempt.request("full"),
    );
    expect(repeated).toBe(first);
    expect(() => between()).toThrow("no longer current");
    expect(() => state.complete()).toThrow("no longer current");
    expect(state.attempt.applied()).toBe(false);
    expect(state.owner.prepareRestart()).toBe(true);
    const replacement = state.owner.forAttempt();
    expect(replacement.owner).toBe(state.attempt.owner);
    expect(replacement.applied()).toBe(true);
    await expect(first).resolves.toBe(true);
    expect(state.params.permissionMode).toBe("full");
    expect(state.publish).not.toHaveBeenCalled();
  } finally {
    state.owner.close();
  }
});

it.each(["source", "run", "deadline", "active-run"] as const)(
  "refuses publication when %s expires after refresh settles but before its continuation",
  async (expired) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = fixture();
    const refresh = createDeferred();
    const completion = refresh.promise.then(state.complete);
    const failure = new Error(`${expired} ended before publication`);
    try {
      refresh.resolve();
      // Promise settlement queued publication; the original owner expires before
      // that queued microtask can mutate the tools, catalog or permission mode.
      if (expired === "source") {
        state.source.abort(failure);
      } else if (expired === "run") {
        state.run.abort(failure);
      } else if (expired === "deadline") {
        vi.setSystemTime(state.deadlineAt);
      } else {
        state.publication.assertActiveRun.mockImplementation(() => {
          throw failure;
        });
      }
      await expect(completion).rejects.toThrow(
        expired === "deadline" ? "foreground turn deadline has expired" : failure,
      );
      expect(state.publish).not.toHaveBeenCalled();
      expect(state.params).toEqual({
        permissionMode: "workspace",
        execOverrides: { mode: "auto" },
      });
      expect(() => state.complete()).toThrow("already consumed");
      if (expired === "active-run") {
        expect(state.publication.assertActiveRun).toHaveBeenCalledOnce();
      }
    } finally {
      refresh.resolve();
      await completion.catch(() => {});
      state.owner.close();
      vi.useRealTimers();
    }
  },
);
