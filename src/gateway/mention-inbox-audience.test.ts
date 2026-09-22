import { createHash } from "node:crypto";
import { StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import * as stateReadOnly from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail, setDisplayName } from "../state/user-profiles.js";
import type { MentionAudienceIdentity } from "./mention-inbox-audience-schema.js";
import {
  applyMentionAudienceCleanup,
  consumeMentionAudience,
  readMentionAudienceCleanup,
  readMentionAudience,
  retainMentionAudience,
} from "./mention-inbox-audience-store.js";
import * as mentionPersistence from "./mention-inbox-persistence.js";
import { MENTION_RETENTION_MS, readMentionStoreSnapshot } from "./mention-inbox-store.js";
import {
  SESSION_ID,
  holdMentionInboxRead,
  listMentionInbox,
  dismissMentionInbox,
  SESSION_KEY,
  withMentionInbox,
  readMentionInbox,
} from "./mention-inbox.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";

it("reconciles a profile merge arriving after the worker mutation result", async () => {
  const createPersistence = mentionPersistence.createMentionInboxPersistence;
  let mergeAfterMutation: (() => void) | undefined;
  const spy = vi
    .spyOn(mentionPersistence, "createMentionInboxPersistence")
    .mockImplementation((params) => {
      const persistence = createPersistence(params);
      return {
        ...persistence,
        async mutate(...args) {
          const result = await persistence.mutate(...args);
          if (args[0].kind === "maintain") {
            const merge = mergeAfterMutation;
            mergeAfterMutation = undefined;
            merge?.();
          }
          return result;
        },
      };
    });
  try {
    await withMentionInbox(async (f) => {
      const old = ensureProfileForEmail("late-merge@mentions.example.test");
      const oldClient = identifiedClient(old.id, "Bob");
      await f.post("late-profile-merge", { recipientProfileIds: [old.id] });
      const retained = (await readMentionInbox(f.inbox, oldClient)).items[0]!;
      let merged = false;
      mergeAfterMutation = () => {
        linkEmail("late-merge@mentions.example.test", f.bob.id);
        merged = true;
      };
      setDisplayName(f.alice.id, "Alice Updated");
      await readMentionInbox(f.inbox, oldClient);
      expect(merged).toBe(true);
      const current = (await readMentionInbox(f.inbox, f.bobClient)).items;
      expect(current.map(({ id, messageId }) => ({ id, messageId }))).toEqual([
        { id: retained.id, messageId: retained.messageId },
      ]);
      expect(f.push).toHaveBeenCalledTimes(1);
    });
  } finally {
    spy.mockRestore();
  }
});

it("keeps optional Inbox storage failures from aborting Gateway construction", async () => {
  await withMentionInbox(async (f) => {
    const execute = stateReadOnly.executeExistingOpenClawStateRead;
    const read = vi
      .spyOn(stateReadOnly, "executeExistingOpenClawStateRead")
      .mockImplementation((...args) => {
        if (args[1].type === "mentions.read") {
          throw new Error("isolated Inbox storage unavailable");
        }
        return execute(...args);
      });
    try {
      const reopened = f.openInbox();
      expect(await listMentionInbox(reopened, f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      read.mockRestore();
      expect((await readMentionInbox(reopened, f.bobClient)).items).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });
});

it("keeps admitted audiences private across restart, retry, consumption and dismissal", async () => {
  await withMentionInbox(async (f) => {
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "everyone-source",
      senderProfileId: f.alice.id,
      requestFingerprint: createHash("sha256").update("@everyone").digest("hex"),
    };
    const assertCurrent = vi.fn();
    await f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
      recipients: [f.bob.id, f.carol.id],
      recovered: false,
      assertCurrent,
    });
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await readMentionInbox(f.inbox, f.bobClient)).items).toEqual([]);
    const { db } = openOpenClawStateDatabase();
    const original = readMentionAudience(db, identity);
    expect(original?.recipients).toEqual([f.bob.id, f.carol.id]);
    const late = ensureProfileForEmail("late-private-audience@example.test");
    await f.inbox.dispose();
    const reopened = f.openInbox();
    await reopened.retainEveryoneAudience(f.aliceClient, identity, {
      recipients: [late.id],
      recovered: true,
      assertCurrent,
    });
    expect(readMentionAudience(db, identity)).toEqual(original);
    await f.post(
      identity.sourceId,
      { recipientProfileIds: [f.bob.id], everyoneAudience: { identity, retained: true } },
      reopened,
    );
    expect(readMentionAudience(db, identity)).toBeUndefined();
    expect((await readMentionInbox(reopened, f.bobClient)).items).toHaveLength(1);
    expect((await readMentionInbox(reopened, f.carolClient)).items).toHaveLength(1);
    expect(f.push).toHaveBeenCalledTimes(2);
    const id = (await readMentionInbox(reopened, f.bobClient)).items[0]!.id;
    await dismissMentionInbox(reopened, f.bobClient, [id]);
    await f.post(
      identity.sourceId,
      { recipientProfileIds: [f.bob.id], everyoneAudience: { identity, retained: true } },
      reopened,
    );
    expect((await readMentionInbox(reopened, f.bobClient)).items).toEqual([]);
    expect(f.push).toHaveBeenCalledTimes(2);
  });
});

it("refuses conflicting source identity, stale authority, session replacement and oversized custody", async () => {
  await withMentionInbox(async (f) => {
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "identity-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    await f.inbox.retainEveryoneAudience(f.aliceClient, identity, options);
    await expect(
      f.inbox.retainEveryoneAudience(
        f.aliceClient,
        { ...identity, requestFingerprint: "b".repeat(64) },
        options,
      ),
    ).rejects.toThrow("conflicts");
    await expect(
      f.inbox.retainEveryoneAudience(
        f.bobClient,
        { ...identity, senderProfileId: f.bob.id },
        options,
      ),
    ).rejects.toThrow("conflicts");
    await expect(
      f.inbox.retainEveryoneAudience(
        f.aliceClient,
        { ...identity, sourceId: "revoked" },
        {
          ...options,
          assertCurrent: () => {
            throw new Error("revoked");
          },
        },
      ),
    ).rejects.toThrow("revoked");
    await expect(
      f.inbox.retainEveryoneAudience(
        f.aliceClient,
        { ...identity, sourceId: "oversized" },
        { ...options, recipients: Array.from({ length: 1001 }, (_, i) => "person-" + i) },
      ),
    ).rejects.toThrow();
    await f.setSession({ sessionId: "replacement" });
    await expect(f.inbox.retainEveryoneAudience(f.aliceClient, identity, options)).rejects.toThrow(
      "session",
    );
    await f.post(identity.sourceId, {
      recipientProfileIds: [],
      everyoneAudience: { identity, retained: true },
    });
    expect(f.push).not.toHaveBeenCalled();
  });
});

it("retires redacted custody and expires abandoned custody without re-expanding recovered input", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "redacted-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    await f.inbox.retainEveryoneAudience(f.aliceClient, identity, options);
    await f.post(identity.sourceId, {
      recipientProfileIds: [],
      everyoneAudience: { identity, retained: false },
    });
    const { db } = openOpenClawStateDatabase();
    expect(readMentionAudience(db, identity)).toBeUndefined();
    expect(f.push).not.toHaveBeenCalled();
    const abandoned = { ...identity, sourceId: "abandoned-source" };
    await f.inbox.retainEveryoneAudience(f.aliceClient, abandoned, options);
    await vi.advanceTimersByTimeAsync(MENTION_RETENTION_MS);
    await readMentionInbox(f.inbox, f.bobClient);
    expect(readMentionAudience(db, abandoned)).toBeUndefined();
    await expect(
      f.inbox.retainEveryoneAudience(f.aliceClient, abandoned, { ...options, recovered: true }),
    ).rejects.toThrow("unavailable");
    expect(readMentionAudience(db, abandoned)).toBeUndefined();
  });
});

it("delivers every aged collected source before cleanup observes their shared consumption", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const scope = { agentId: "main", sessionKey: SESSION_KEY, sessionId: SESSION_ID };
    const target = () => ({
      ...scope,
      sessionEntry: loadSessionEntry(scope),
      expectedSessionId: SESSION_ID,
    });
    const sources = [];
    const { db } = openOpenClawStateDatabase();
    const schema = () => ({
      version: db.prepare("PRAGMA user_version").get(),
      metadata: db.prepare("SELECT * FROM schema_meta").all(),
      ddl: db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),
    });
    const before = schema();
    f.push.mockImplementation((notification) => {
      expect(notification.isCurrent()).toBe(true);
    });
    for (let index = 0; index < 2; index++) {
      const identity: MentionAudienceIdentity = {
        ...scope,
        sourceId: "collected-" + index + ":user",
        senderProfileId: f.alice.id,
        requestFingerprint: String(index).repeat(64),
      };
      const source = createUserTurnTranscriptRecorder({
        input: {
          text: "@everyone",
          mentions: [{ kind: "everyone", start: 0, end: 9 }],
          idempotencyKey: identity.sourceId,
        },
        target,
        pendingInputRequestFingerprint: identity.requestFingerprint,
        preparePendingInputSourceCustody: ({ recovered }) =>
          f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
            recipients: [f.bob.id],
            recovered,
            assertCurrent: () => {},
          }),
        retainOriginalInputCompletion: () => f.inbox.reserveCommittedInput(),
        onOriginalInputCommitted: () =>
          f.post(identity.sourceId, {
            recipientProfileIds: [],
            everyoneAudience: { identity, retained: true },
          }),
      });
      await source.stageApproved?.({ runId: "collected-" + index, assertCurrent: () => {} });
      sources.push(source);
    }
    expect(schema()).toEqual(before);
    // Advance wall time without firing the Inbox timer: this reproduces cleanup at commit.
    vi.setSystemTime(Date.now() + MENTION_RETENTION_MS + 1);
    const aggregate = createUserTurnTranscriptRecorder({
      input: {
        text: "@everyone\n@everyone",
        mentions: [{ kind: "everyone", start: 0, end: 9 }],
        idempotencyKey: "aggregate:user",
      },
      pendingInputSources: sources,
      target,
    });
    await aggregate.persistApproved();
    expect((await readMentionInbox(f.inbox, f.bobClient)).items).toHaveLength(2);
    expect(f.push).toHaveBeenCalledTimes(2);
    expect(schema()).toEqual(before);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

it.each([false, true])(
  "fences stale cleanup after same-source custody renewal (expired and re-admitted: %s)",
  async (readmitted) => {
    await withMentionInbox(async (f) => {
      vi.useFakeTimers();
      const identity: MentionAudienceIdentity = {
        agentId: "main",
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        sourceId: "reclaimed-source",
        senderProfileId: f.alice.id,
        requestFingerprint: "a".repeat(64),
      };
      const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
      await f.inbox.retainEveryoneAudience(f.aliceClient, identity, options);
      vi.setSystemTime(Date.now() + MENTION_RETENTION_MS + 1);
      const { db } = openOpenClawStateDatabase();
      const plan = readMentionAudienceCleanup(db).map((row) =>
        Object.assign(row, { retained: false }),
      );
      expect(plan).toHaveLength(1);
      // Claim directly through the store in a current owner's transaction, between plan and apply.
      runOpenClawStateWriteTransaction(({ db: database }) => {
        if (readmitted) {
          consumeMentionAudience(database, identity);
        }
        retainMentionAudience(database, identity, [f.carol.id]);
        applyMentionAudienceCleanup(database, plan);
      });
      expect(readMentionAudience(db, identity)?.recipients).toEqual([
        readmitted ? f.carol.id : f.bob.id,
      ]);
    });
  },
);

it("bounds private custody and cleans expired preparations before admitting at capacity", async () => {
  await withMentionInbox(async (f) => {
    vi.useFakeTimers();
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "capacity-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    const { db } = openOpenClawStateDatabase();
    runOpenClawStateWriteTransaction(() => {
      const insert = db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,?)",
      );
      for (let index = 0; index < 10000; index++) {
        const receipt = {
          ...identity,
          sourceId: "capacity-" + index,
          createdAt: Date.now(),
          recipients: [f.bob.id],
        };
        const hash = createHash("sha256")
          .update(
            JSON.stringify([
              receipt.agentId,
              receipt.sessionKey,
              receipt.sessionId,
              receipt.sourceId,
            ]),
          )
          .digest("hex");
        insert.run("notifications.mentions.audience." + hash, JSON.stringify(receipt), Date.now());
      }
    });
    const options = { recipients: [f.bob.id], recovered: false, assertCurrent: () => {} };
    await expect(f.inbox.retainEveryoneAudience(f.aliceClient, identity, options)).rejects.toThrow(
      "retention is full",
    );
    await f.inbox.dispose();
    vi.setSystemTime(Date.now() + MENTION_RETENTION_MS + 1);
    const reopened = f.openInbox();
    await reopened.retainEveryoneAudience(f.aliceClient, identity, options);
    expect(readMentionAudience(db, identity)?.recipients).toEqual([f.bob.id]);
    expect(
      Number(
        db
          .prepare(
            "SELECT count(*) AS count FROM config_machine_state WHERE state_key >= ? AND state_key < ?",
          )
          .get("notifications.mentions.audience.", "notifications.mentions.audience/")?.count,
      ),
    ).toBeLessThanOrEqual(10000);
  });
});

it("rolls receipt consumption back when live authority changes at worker commit and never publishes uncommitted push", async () => {
  const cfg: OpenClawConfig = {};
  await withMentionInbox(async (f) => {
    const identity: MentionAudienceIdentity = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      sourceId: "atomic-source",
      senderProfileId: f.alice.id,
      requestFingerprint: "a".repeat(64),
    };
    await f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
      recipients: [f.bob.id],
      recovered: false,
      assertCurrent: () => {},
    });
    const { db } = openOpenClawStateDatabase();
    // Revoke the real host guard when the worker requests its commit grant,
    // after receipt consumption and source insertion but before COMMIT.
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let commits = 0;
    const revoke = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit" && ++commits === 2) {
            // Involvement commits first; the Inbox transaction follows.
            cfg.session = { sharing: { readOnly: false } };
          }
          admit(request, grant);
        }),
      );
    const post = () =>
      f.post(identity.sourceId, {
        recipientProfileIds: [],
        everyoneAudience: { identity, retained: true },
      });
    try {
      await post();
    } finally {
      revoke.mockRestore();
      delete cfg.session;
    }
    expect(commits).toBe(2);
    expect(readMentionStoreSnapshot(-1)?.sources).toEqual([]);
    expect(readMentionAudience(db, identity)?.recipients).toEqual([f.bob.id]);
    expect(f.push).not.toHaveBeenCalled();
    await post();
    expect(readMentionAudience(db, identity)).toBeUndefined();
    expect(f.push).toHaveBeenCalledOnce();
  }, cfg);
});

describe("worker-owned mention Inbox", () => {
  it("runs registered Inbox reads, custody, delivery and dismissal SQL off the Gateway thread", async () => {
    await withMentionInbox(async (f) => {
      // Projection admission owns its existing preparation SQL; observe only feature SQL
      // after that owner is ready, not every SQLite statement in the Gateway process.
      await readMentionInbox(f.inbox, f.bobClient);
      await f.inbox.prepareRecipients(true);
      const mainThreadSql: string[] = [];
      const observe = (statement: StatementSync, values: readonly unknown[]) => {
        if (
          /config_machine_state/i.test(statement.sourceSQL) &&
          [statement.sourceSQL, ...values].some(
            (value) => typeof value === "string" && value.includes("notifications.mentions."),
          )
        ) {
          mainThreadSql.push(statement.sourceSQL);
        }
      };
      // oxlint-disable-next-line typescript/unbound-method -- apply retains each native statement receiver.
      const { get, all, run } = StatementSync.prototype;
      const spies = [
        vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
          this: StatementSync,
          ...values
        ) {
          observe(this, values);
          return get.apply(this, values);
        }),
        vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
          this: StatementSync,
          ...values
        ) {
          observe(this, values);
          return all.apply(this, values);
        }),
        vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (
          this: StatementSync,
          ...values
        ) {
          observe(this, values);
          return run.apply(this, values);
        }),
      ];
      try {
        const identity = {
          agentId: "main",
          sessionKey: SESSION_KEY,
          sessionId: SESSION_ID,
          sourceId: "worker-owned",
          senderProfileId: f.alice.id,
          requestFingerprint: "a".repeat(64),
        };
        await f.inbox.retainEveryoneAudience(f.aliceClient, identity, {
          recipients: [f.bob.id],
          recovered: false,
          assertCurrent: () => {},
        });
        await f.post(identity.sourceId, {
          recipientProfileIds: [],
          everyoneAudience: { identity, retained: true },
        });
        const listed = await f.call("mentions.list", {});
        expect(listed).toMatchObject({
          ok: true,
          payload: { items: [{ messageId: "message-worker-owned" }] },
        });
        const id = (await readMentionInbox(f.inbox, f.bobClient)).items[0]!.id;
        expect(await f.call("mentions.dismiss", { ids: [id] })).toMatchObject({
          ok: true,
          payload: { items: [] },
        });
        await f.inbox.dispose();
        expect(mainThreadSql).toEqual([]);
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
      const stored = readMentionStoreSnapshot(-1)!;
      expect(stored.sources).toHaveLength(1);
      expect(stored.sources[0]!.recipients).toEqual([[f.bob.id, null]]);
    });
  });

  it.each(["mentions.list", "mentions.dismiss"])(
    "%s propagates publication exceptions without publishing a second response",
    async (method) => {
      await withMentionInbox(async (f) => {
        await f.post();
        const id = (await readMentionInbox(f.inbox, f.bobClient)).items[0]!.id;
        const error = new Error("synthetic response failure");
        const respond = vi.fn(() => {
          throw error;
        });
        await expect(
          f.call(method, method === "mentions.dismiss" ? { ids: [id] } : {}, f.bobClient, respond),
        ).rejects.toBe(error);
        expect(respond).toHaveBeenCalledOnce();
      });
    },
  );

  it.each(["mentions.list", "mentions.dismiss"])(
    "%s rechecks requester authority after the real worker reply",
    async (method) => {
      await withMentionInbox(async (f) => {
        await f.post();
        const id = (await readMentionInbox(f.inbox, f.bobClient)).items[0]!.id;
        const held = holdMentionInboxRead();
        const response = vi.fn();
        const pending = f.call(
          method,
          method === "mentions.dismiss" ? { ids: [id] } : {},
          f.bobClient,
          response,
        );
        try {
          await held.ready;
          expect(response).not.toHaveBeenCalled();
          Object.assign(f.bobClient, { invalidated: true });
          held.release();
          expect((await pending).ok).toBe(false);
          expect(response).toHaveBeenCalledOnce();
          expect(
            (await readMentionInbox(f.inbox, f.bobSecond)).items.map((item) => item.id),
          ).toEqual([id]);
        } finally {
          held.release();
          await pending;
          held.restore();
        }
      });
    },
  );

  it("joins an admitted commit before shutdown and refuses later Inbox admissions", async () => {
    await withMentionInbox(async (f) => {
      await readMentionInbox(f.inbox, f.bobClient);
      const held = holdMentionInboxRead();
      const committed = f.post("drained-on-close");
      let closed = false;
      let closing: Promise<void> | undefined;
      try {
        await held.ready;
        closing = f.inbox.dispose().then(() => {
          closed = true;
        });
        expect(closed).toBe(false);
        expect(await f.call("mentions.list", {})).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE" },
        });
        held.release();
        await committed;
        await closing;
        expect(closed).toBe(true);
        const restarted = f.openInbox("after-joined-close");
        expect(
          (await readMentionInbox(restarted, f.bobClient)).items.map((item) => item.messageId),
        ).toEqual(["message-drained-on-close"]);
      } finally {
        held.release();
        await committed;
        await closing;
        held.restore();
      }
    });
  });
});
