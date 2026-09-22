import fs from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  acquireHistoryDatabaseResource,
  historyPages,
} from "../config/sessions/session-transcript-worker-resources.js";
import { bumpAgentRunIndexVersion } from "../infra/agent-run-registry-state.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "../state/openclaw-agent-db-lifecycle.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getSessionEntry, withSessionEntriesRead } from "./session-store-runtime.js";

it("retains the process-owned incognito reader without dispatching a durable worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const params = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-binding-read",
      storePath: state.statePath("unused-durable.sqlite"),
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false as const,
    };
    replaceSessionEntrySync(params, {
      sessionId: "private-current",
      incognito: true,
      updatedAt: 1,
    });
    const expected = getSessionEntry(params);
    const dispatch = vi.spyOn(historyPages, "run");
    try {
      expect(await withSessionEntriesRead([params], ([entry]) => entry)).toEqual(expected);
      expect(dispatch).not.toHaveBeenCalled();
      expect(fs.existsSync(params.storePath)).toBe(false);
    } finally {
      dispatch.mockRestore();
    }
  });
});

it("reads shared physical stores off thread and preserves the public exact entry", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("shared.sqlite"),
    });
    const params = {
      agentId: "other",
      sessionKey: "agent:other:exact",
      storePath: database.path,
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false as const,
    };
    replaceSessionEntrySync(params, {
      sessionId: "current",
      updatedAt: 1,
      activeWriterRunId: "private",
    });
    const expected = getSessionEntry(params);
    const alias = state.statePath("shared-alias.sqlite");
    fs.symlinkSync(database.path, alias);
    const statement: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const connection: DatabaseSync = Object.getPrototypeOf(database.db);
    const rotate = vi.spyOn(historyPages, "rotate");
    const spies = [
      vi.spyOn(statement, "all"),
      vi.spyOn(statement, "get"),
      vi.spyOn(statement, "iterate"),
      vi.spyOn(statement, "run"),
      vi.spyOn(connection, "exec"),
    ];
    try {
      expect(await withSessionEntriesRead([params], ([entry]) => entry)).toEqual(expected);
      expect(rotate).not.toHaveBeenCalled();
      const physical = acquireHistoryDatabaseResource({ agentId: "main", path: database.path });
      expect(physical.nativeSequences.size).toBeGreaterThan(0);
      expect(
        await withSessionEntriesRead([{ ...params, storePath: alias }], ([entry]) => entry),
      ).toEqual(expected);
      expect(expected).not.toHaveProperty("activeWriterRunId");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(rotate).toHaveBeenCalled();
      expect(physical.nativeSequences.size).toBe(0);
      await closeOpenClawAgentDatabaseByPathAsync(alias);
      expect(physical.nativeSequences.size).toBe(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
      rotate.mockRestore();
    }
  });
});

it("consumes the fresh row in writer order and rejects asynchronous consumers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const params = {
      agentId: "main",
      sessionKey: "agent:main:ordered",
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false as const,
    };
    replaceSessionEntrySync(params, { sessionId: "before", updatedAt: 1 });
    const started = createDeferredCore();
    const release = createDeferredCore();
    const writer = runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
      started.resolve();
      await release.promise;
      replaceSessionEntrySync(params, { sessionId: "after", updatedAt: 2 });
    });
    await started.promise;
    let consumed = false;
    const read = withSessionEntriesRead([params], ([entry]) => {
      consumed = true;
      return entry?.sessionId;
    });
    expect(consumed).toBe(false);
    release.resolve();
    await writer;
    expect(await read).toBe("after");
    await expect(withSessionEntriesRead([params], async () => "invalid")).rejects.toThrow(
      "must remain synchronous",
    );
  });
});

it("does not create missing stores and rejects a revoked physical reader", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const missing = {
      agentId: "absent",
      sessionKey: "agent:absent:missing",
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false as const,
    };
    expect(await withSessionEntriesRead([missing], ([entry]) => entry)).toBeUndefined();
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "absent" }))).toBe(false);
    const params = { ...missing, agentId: "main", sessionKey: "agent:main:revoked" };
    replaceSessionEntrySync(params, { sessionId: "before", updatedAt: 1 });
    const consume = vi.fn();
    const read = withSessionEntriesRead([params], consume).then(
      () => "returned",
      () => "revoked",
    );
    await closeOpenClawAgentDatabasesAsync();
    expect(await read).toBe("revoked");
    expect(consume).not.toHaveBeenCalled();
  });
});

it.each(["session", "global"] as const)(
  "keeps durable session authority across %s run-index publication",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const params = {
        agentId: "main",
        sessionKey: "agent:main:run-index",
        readConsistency: "latest" as const,
        hydrateSkillPromptRefs: false as const,
      };
      replaceSessionEntrySync(params, { sessionId: "current", updatedAt: 1 });
      const expected = getSessionEntry(params);
      const run = historyPages.run.bind(historyPages);
      let published = false;
      const spy = vi.spyOn(historyPages, "run").mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (
          !published &&
          reply.ok &&
          typeof reply.value === "object" &&
          !Array.isArray(reply.value) &&
          reply.value.kind === "session-exact-entries"
        ) {
          published = true;
          bumpAgentRunIndexVersion(scope === "session" ? params : undefined);
        }
        return reply;
      });
      try {
        expect(await withSessionEntriesRead([params], ([entry]) => entry)).toEqual(expected);
        expect(published).toBe(true);
        expect(getSessionEntry(params)).toEqual(expected);
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it.each(["same-ID lineage", "folded alias"] as const)(
  "rejects %s publication between worker result and consumption",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const params = {
        agentId: "main",
        sessionKey: "agent:main:matrix:channel:!MixedCase:example.org",
        readConsistency: "latest" as const,
        hydrateSkillPromptRefs: false as const,
      };
      replaceSessionEntrySync(params, {
        sessionId: "current",
        previousSessionId: "before",
        updatedAt: 1,
      });
      const run = historyPages.run.bind(historyPages);
      let changed = false;
      const spy = vi.spyOn(historyPages, "run").mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (
          !changed &&
          reply.ok &&
          typeof reply.value === "object" &&
          !Array.isArray(reply.value) &&
          reply.value.kind === "session-exact-entries"
        ) {
          changed = true;
          if (scenario === "same-ID lineage") {
            replaceSessionEntrySync(params, {
              sessionId: "current",
              previousSessionId: "after",
              updatedAt: 2,
            });
          } else {
            // Logical reads also validate folded candidates. A publication affecting
            // such a candidate invalidates even when the requested row did not change.
            sessionChanges.emit({
              sessionKey: params.sessionKey.toLowerCase(),
              storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            });
          }
        }
        return reply;
      });
      const consume = vi.fn();
      try {
        await expect(withSessionEntriesRead([params], consume)).rejects.toThrow(
          "changed during read",
        );
        expect(consume).not.toHaveBeenCalled();
        expect(await withSessionEntriesRead([params], ([entry]) => entry?.previousSessionId)).toBe(
          scenario === "same-ID lineage" ? "after" : "before",
        );
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it("composes opposite-order source batches and duplicate sources without releasing a reader early", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const first = {
      agentId: "a",
      sessionKey: "agent:a:one",
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false as const,
    };
    const second = { ...first, agentId: "b", sessionKey: "agent:b:two" };
    replaceSessionEntrySync(first, { sessionId: "one", updatedAt: 1 });
    replaceSessionEntrySync(second, { sessionId: "two", updatedAt: 1 });
    expect(
      await Promise.all([
        withSessionEntriesRead([first, second, first], (entries) =>
          entries.map((entry) => entry?.sessionId),
        ),
        withSessionEntriesRead([second, first], (entries) =>
          entries.map((entry) => entry?.sessionId),
        ),
      ]),
    ).toEqual([
      ["one", "two", "one"],
      ["two", "one"],
    ]);
    const run = historyPages.run.bind(historyPages);
    let exactReads = 0;
    const spy = vi.spyOn(historyPages, "run").mockImplementation(async (...args) => {
      const reply = await run(...args);
      if (
        reply.ok &&
        typeof reply.value === "object" &&
        !Array.isArray(reply.value) &&
        reply.value.kind === "session-exact-entries" &&
        ++exactReads === 2
      ) {
        replaceSessionEntrySync(first, { sessionId: "replaced", updatedAt: 2 });
      }
      return reply;
    });
    const consume = vi.fn();
    try {
      await expect(withSessionEntriesRead([first, second], consume)).rejects.toThrow(
        "changed during read",
      );
      expect(consume).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

it("rejects selected inherited writer scopes, including detached consumers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const params = {
      agentId: "main",
      sessionKey: "agent:main:reentry",
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false as const,
    };
    replaceSessionEntrySync(params, { sessionId: "current", updatedAt: 1 });
    const consume = vi.fn();
    await runOpenClawAgentWriteAdmission({ agentId: "main" }, async () => {
      await expect(withSessionEntriesRead([params], consume)).rejects.toThrow("cannot reenter");
    });
    let detached: Promise<unknown> | undefined;
    // Capture rejection while the outer owner is still active; detached work
    // must not borrow its queue and outlive the parent's release.
    await withSessionEntriesRead([params], () => {
      detached = withSessionEntriesRead([params], consume).then(
        () => "returned",
        (error: Error) => error.message,
      );
    });
    expect(await detached).toContain("cannot reenter");
    expect(consume).not.toHaveBeenCalled();
  });
});
