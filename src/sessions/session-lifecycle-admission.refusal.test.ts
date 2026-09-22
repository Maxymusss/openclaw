import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  beginSessionWorkAdmission,
  closeSessionWorkAdmissions,
  consumeSessionWorkAdmissionHandoff,
  isSessionWorkAdmissionActive,
} from "./session-lifecycle-admission.js";
import { SessionWorkCleanupUnconfirmedError } from "./session-work-admission-interruption.js";

it("commits refusal despite a throwing pending callback, across release, handoff and promotion", async () => {
  const scope = "cleanup-refusal.sqlite";
  const identities = ["agent:main:cleanup-refusal", "cleanup-refusal-session"];
  const owner = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
  const handoffId = owner.createHandoff();
  const entered = createDeferred();
  const release = createDeferred();
  const notificationError = new Error("pending notification failed");
  const firstInterrupted = vi.fn(() => {
    throw notificationError;
  });
  const laterInterrupted = vi.fn();
  const first = beginSessionWorkAdmission({
    scope,
    identities,
    onInterrupt: firstInterrupted,
    assertAllowed: async () => {
      entered.resolve();
      await release.promise;
    },
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly issued";
    },
    (error: unknown) => error,
  );
  await entered.promise;
  const laterValidator = vi.fn();
  const later = beginSessionWorkAdmission({
    scope,
    identities,
    onInterrupt: laterInterrupted,
    assertAllowed: laterValidator,
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly issued";
    },
    (error: unknown) => error,
  );
  const reason = new SessionWorkCleanupUnconfirmedError();
  try {
    const refusal = owner.refuseNewWork(reason);
    expect(refusal).toEqual({ committed: true, interruptionErrors: [notificationError] });
    expect(firstInterrupted).toHaveBeenCalledExactlyOnceWith(reason);
    expect(laterInterrupted).toHaveBeenCalledExactlyOnceWith(reason);
    expect(await first).toBe(reason);
    expect(await later).toBe(reason);
    expect(laterValidator).not.toHaveBeenCalled();
    const adopted = consumeSessionWorkAdmissionHandoff({ handoffId, scope, identities });
    expect(adopted).toBe(owner);
    expect(adopted?.refuseNewWork(new Error("later reason"))).toBe(refusal);
    expect(firstInterrupted).toHaveBeenCalledOnce();
    owner.release();

    // Admission itself is role-neutral: removing the former guest restriction
    // cannot bypass the negative custody retained by the completed owner.
    const promotedStaffValidator = vi.fn();
    await expect(
      beginSessionWorkAdmission({
        scope,
        identities,
        assertAllowed: promotedStaffValidator,
      }),
    ).rejects.toBe(reason);
    expect(promotedStaffValidator).not.toHaveBeenCalled();
    expect(() => owner.refuseNewWork(reason)).toThrow("released session work admission");
    const unrelated = await beginSessionWorkAdmission({
      scope,
      identities: ["unrelated-session"],
      assertAllowed: () => {},
    });
    unrelated.release();
  } finally {
    release.resolve();
    owner.release();
    await Promise.all([first, later]);
  }
});

it("refuses an acquired reservation queued behind the writer before its revalidation effects", async () => {
  const scope = "refused-writer.sqlite";
  const identities = ["shared-writer-session"];
  const owner = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
  const writerEntered = createDeferred();
  const releaseWriter = createDeferred();
  const writer = runExclusiveSessionStoreWrite(scope, async () => {
    writerEntered.resolve();
    await releaseWriter.promise;
  });
  await writerEntered.promise;
  const revalidate = vi.fn();
  const interrupted = vi.fn();
  const contender = beginSessionWorkAdmission({
    scope,
    identities: [...identities, "queued-writer-contender"],
    assertAllowed: () => {},
    revalidateAllowed: revalidate,
    onInterrupt: interrupted,
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly issued";
    },
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() =>
      expect(isSessionWorkAdmissionActive(scope, ["queued-writer-contender"])).toBe(true),
    );
    const reason = new SessionWorkCleanupUnconfirmedError();
    owner.refuseNewWork(reason);
    expect(interrupted).not.toHaveBeenCalled();
    releaseWriter.resolve();
    expect(await contender).toBe(reason);
    expect(revalidate).not.toHaveBeenCalled();
    // Issued work keeps its existing owner even after new ingress is refused.
    const effect = vi.fn(async () => "already issued staff work");
    expect(await owner.run(effect)).toBe("already issued staff work");
    expect(effect).toHaveBeenCalledOnce();
  } finally {
    releaseWriter.resolve();
    owner.release();
    await Promise.all([writer, contender]);
  }
});

it("checks sticky refusal again after awaited writer validation before issuing its lease", async () => {
  const scope = "refused-revalidation.sqlite";
  const identities = ["async-revalidation-session"];
  const owner = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
  const entered = createDeferred();
  const release = createDeferred();
  const contender = beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {},
    revalidateAllowed: async () => {
      entered.resolve();
      await release.promise;
    },
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly issued";
    },
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    const reason = new SessionWorkCleanupUnconfirmedError();
    owner.refuseNewWork(reason);
    release.resolve();
    expect(await contender).toBe(reason);
  } finally {
    release.resolve();
    owner.release();
    await contender;
  }
});

it("keeps temporary lifecycle closure rollback and release behavior", async () => {
  const scope = "temporary-cleanup-refusal.sqlite";
  const identities = ["temporary-cleanup-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const notificationError = new Error("temporary notification failed");
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    onInterrupt: () => {
      throw notificationError;
    },
    assertAllowed: async () => {
      entered.resolve();
      await release.promise;
    },
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly issued";
    },
    (error: unknown) => error,
  );
  await entered.promise;
  const reason = new Error("temporary lifecycle closure");
  try {
    expect(() => closeSessionWorkAdmissions({ scope, identities, reason })).toThrow(
      notificationError,
    );
    expect(await pending).toBe(reason);
    release.resolve();
    const fresh = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
    fresh.release();
    const reopen = closeSessionWorkAdmissions({ scope, identities, reason });
    await expect(
      beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} }),
    ).rejects.toBe(reason);
    reopen();
    const afterRelease = await beginSessionWorkAdmission({
      scope,
      identities,
      assertAllowed: () => {},
    });
    afterRelease.release();
  } finally {
    release.resolve();
    await pending;
  }
});
