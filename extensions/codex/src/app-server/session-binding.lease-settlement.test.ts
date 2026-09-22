import * as sessionRuntime from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingStoreKey,
  combineCodexBindingAuthority,
  createCodexAppServerBindingStore,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("Codex binding lease settlement", () => {
  it.each(["reader-cleanup", "canceled-after-admission", "canceled-during-run"] as const)(
    "cleans the exact token after %s without borrowing revoked caller authority",
    async (failureAt) => {
      const state = createCodexTestBindingStateStore();
      const store = createCodexAppServerBindingStore(state);
      const identity = { kind: "conversation" as const, bindingId: "settlement" };
      await store.mutate(identity, { kind: "set", binding: { threadId: "native", cwd: "/repo" } });
      const failure = new Error(failureAt);
      let active = true;
      const run = vi.fn(async () => {
        active = false;
        return "native-outcome";
      });
      vi.spyOn(sessionRuntime, "withSessionEntriesRead").mockImplementation(
        async (_reads, consume) => {
          const result = consume([]);
          if (failureAt === "reader-cleanup") throw failure;
          if (failureAt === "canceled-after-admission") active = false;
          return result;
        },
      );
      await expect(
        store.withLease(identity, run, {
          authority: combineCodexBindingAuthority(),
          assertCurrent: () => {
            if (!active) throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(run).toHaveBeenCalledTimes(failureAt === "canceled-during-run" ? 1 : 0);
      expect(state.lookup(bindingStoreKey(identity))?.lease).toBeUndefined();
      expect(store.read(identity)?.threadId).toBe("native");
    },
  );

  it("returns an accepted outcome without a new post-effect lineage read", async () => {
    const state = createCodexTestBindingStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "accepted" };
    let accepted = false;
    vi.spyOn(sessionRuntime, "withSessionEntriesRead").mockImplementation(
      async (_reads, consume) => {
        if (accepted) throw new Error("lineage changed after native acceptance");
        return consume([]);
      },
    );
    await expect(
      store.withLease(
        identity,
        async () => {
          accepted = true;
          return { accepted: true };
        },
        { authority: combineCodexBindingAuthority() },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(state.lookup(bindingStoreKey(identity))?.lease).toBeUndefined();
  });

  it("does not remove a successor token while settling a revoked caller", async () => {
    const state = createCodexTestBindingStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "replaced" };
    const key = bindingStoreKey(identity);
    const successor = {
      version: 1 as const,
      state: "active" as const,
      binding: { threadId: "successor", cwd: "/repo" },
      lease: { token: "successor-token", expiresAt: Date.now() + 60_000 },
    };
    const failure = new Error("caller revoked");
    await expect(
      store.withLease(identity, async () => {
        state.register(key, successor);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(state.lookup(key)).toEqual(successor);
  });
});
