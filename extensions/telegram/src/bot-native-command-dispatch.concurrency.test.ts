import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { runWithTelegramSpooledReplayUpdate } from "./bot-processing-outcome.js";
import {
  createBot,
  from,
  groupCommand,
  harness,
  photo,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { resolveTelegramForumFlag } from "./bot/helpers.js";
import { getTelegramRuntime } from "./runtime.js";

const DEBOUNCE_MS = 4321;

function createDebouncedBot(
  native: boolean,
  commandSenders = [String(from.id)],
  groupSenders = commandSenders,
) {
  return createBot(native, true, {
    agents: { defaults: { models: { "fixture/next": { alias: "quick" } } } },
    commands: { native, text: true, allowFrom: { telegram: commandSenders } },
    messages: { inbound: { byChannel: { telegram: DEBOUNCE_MS } } },
    channels: {
      telegram: {
        groupPolicy: "open",
        groupAllowFrom: [...new Set([String(from.id), ...groupSenders])],
        groups: { "*": { requireMention: false } },
        streaming: { mode: "off" },
      },
    },
  });
}

function ordinaryMessage(text: string, threadId: number) {
  return { ...groupCommand(text, threadId), entities: [] };
}

function takeDebounceFlush(delayMs = DEBOUNCE_MS): () => void {
  const timer = vi.mocked(globalThis.setTimeout);
  const index = timer.mock.calls.findLastIndex((call) => call[1] === delayMs);
  expect(index).toBeGreaterThanOrEqual(0);
  // SAFETY: This handle is the recorded return value of the real setTimeout spy.
  clearTimeout(timer.mock.results[index]?.value as ReturnType<typeof setTimeout>);
  const callback = timer.mock.calls[index]?.[0];
  if (typeof callback !== "function") {
    throw new Error("Expected the pending Telegram debounce timer");
  }
  return () => callback();
}

function createTestLifetime(
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  cleanup: () => Promise<void>,
) {
  const canceled = createDeferred<never>();
  // Cancellation can precede the next wait while an update is being admitted.
  void canceled.promise.catch(() => {});
  let cleanupTask: Promise<void> | undefined;
  const close = () =>
    (cleanupTask ??= Promise.resolve()
      .then(cleanup)
      .finally(() => signal.removeEventListener("abort", onAbort)));
  const onAbort = () => {
    canceled.reject(signal.reason);
    // Vitest rejects its wrapper on timeout without unwinding the test body.
    // Start release/join now; onTestFinished still observes any cleanup failure.
    void close().catch(() => {});
  };
  onTestFinished(close);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return {
    wait: <T>(promise: Promise<T>) => Promise.race([promise, canceled.promise]),
    close,
  };
}

describe("Telegram commands during buffered message processing", () => {
  it.for([
    { native: true, command: "/model fixture/next" },
    { native: false, command: "/model fixture/next" },
    { native: false, command: "/quick" },
    { native: true, command: "/status" },
    { native: false, command: "/status" },
    { native: true, command: "/btw check this" },
    { native: false, command: "/btw check this" },
  ])(
    "dispatches $command and cross-topic /stop while an ordinary run is held (native=$native)",
    async ({ native, command }, context) => {
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const controlEntered = createDeferred<void>();
      const stopEntered = createDeferred<void>();
      harness.replySpy.mockImplementation(async (ctx) => {
        if (ctx.RawBody === "ordinary run") {
          started.resolve();
          await release.promise;
        } else if (ctx.RawBody === command) {
          controlEntered.resolve();
        } else if (ctx.RawBody === "/stop") {
          stopEntered.resolve();
        }
        return undefined;
      });
      const bot = createDebouncedBot(native);
      const timer = vi.spyOn(globalThis, "setTimeout");
      const work: Promise<unknown>[] = [];
      const flushes: Array<() => void> = [];
      const lifetime = createTestLifetime(context, async () => {
        release.resolve();
        for (const flush of flushes) {
          flush();
        }
        await Promise.allSettled(work);
        timer.mockRestore();
      });
      let updateId = 5000;
      const dispatch = (message: ReturnType<typeof groupCommand>) => {
        const update = { update_id: ++updateId, message };
        const pending = runWithTelegramSpooledReplayUpdate(update, () => bot.handleUpdate(update));
        work.push(pending);
        return pending;
      };
      const buffer = async (text: string, threadId: number) => {
        const result = await dispatch(ordinaryMessage(text, threadId));
        const participant = result.deferredWork;
        if (!participant) {
          throw new Error("Expected a durable participant for buffered Telegram input");
        }
        work.push(participant.task);
        const flush = takeDebounceFlush();
        flushes.push(flush);
        return { participant, flush };
      };

      try {
        const active = await buffer("ordinary run", 99);
        active.flush();
        await lifetime.wait(started.promise);
        const sameTopic = await buffer("same-topic follow-up", 99);
        const otherTopic = await buffer("cancel this topic", 100);

        // These updates traverse the real grammY command and message handlers. A
        // status stuck behind the active debounce flush also stalls the shared
        // control lane, including a stop targeting another topic.
        const control = dispatch(groupCommand(command, 99));
        const stop = dispatch(groupCommand("/stop", 100));
        await lifetime.wait(Promise.all([controlEntered.promise, stopEntered.promise]));
        expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody ?? "").toSorted()).toEqual(
          ["ordinary run", command, "/stop"].toSorted(),
        );
        await lifetime.wait(Promise.all([control, stop]));
        expect(active.participant.isSettled()).toBe(false);
        expect(sameTopic.participant.isSettled()).toBe(false);
        await expect(lifetime.wait(otherTopic.participant.task)).resolves.toEqual({
          kind: "skipped",
        });
        expect(
          harness.replySpy.mock.calls.find(([ctx]) => ctx.RawBody === command)?.[0],
        ).toMatchObject({
          CommandSource: native ? "native" : "text",
          CommandAuthorized: true,
          MessageThreadId: 99,
        });
        expect(
          harness.replySpy.mock.calls.find(([ctx]) => ctx.RawBody === "/stop")?.[0],
        ).toMatchObject({
          CommandAuthorized: true,
          MessageThreadId: 100,
        });

        release.resolve();
        await expect(lifetime.wait(active.participant.task)).resolves.toEqual({
          kind: "completed",
        });
        sameTopic.flush();
        await expect(lifetime.wait(sameTopic.participant.task)).resolves.toEqual({
          kind: "completed",
        });
        expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody ?? "").toSorted()).toEqual(
          ["ordinary run", command, "/stop", "same-topic follow-up"].toSorted(),
        );
      } finally {
        await lifetime.close();
      }
    },
  );

  it("keeps a model alias owned by a skill behind pending text fragments", async (context) => {
    const collisionChecked = createDeferred<void>();
    const aliasEntered = createDeferred<void>();
    harness.listSkillCommandsForAgents.mockImplementation(() => {
      collisionChecked.resolve();
      return [
        {
          name: "quick",
          skillName: "quick",
          description: "Tool command",
          dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
        },
      ];
    });
    harness.replySpy.mockImplementation(async (ctx) => {
      if (ctx.RawBody === "/quick") {
        aliasEntered.resolve();
      }
      return undefined;
    });
    const guest = { ...from, id: from.id + 1, first_name: "Grace" } as never;
    const bot = createDebouncedBot(false, [String(from.id), String(from.id + 1)]);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const work: Promise<unknown>[] = [];
    const flushes: Array<() => void> = [];
    const lifetime = createTestLifetime(context, async () => {
      for (const flush of flushes) {
        flush();
      }
      await Promise.allSettled(work);
      timer.mockRestore();
    });
    let updateId = 7000;
    const dispatch = async (message: ReturnType<typeof groupCommand>) => {
      const update = { update_id: ++updateId, message };
      const pending = runWithTelegramSpooledReplayUpdate(update, () => bot.handleUpdate(update));
      work.push(pending);
      const result = await lifetime.wait(pending);
      if (!result.deferredWork) {
        throw new Error("Expected buffered Telegram input to retain a durable participant");
      }
      work.push(result.deferredWork.task);
      return result.deferredWork;
    };

    try {
      const fragment = await dispatch(ordinaryMessage("x".repeat(4000), 99));
      const flush = takeDebounceFlush(1500);
      flushes.push(flush);
      const aliasPending = dispatch({
        ...groupCommand("/quick", 99),
        from: guest,
      });
      await expect(
        lifetime.wait(
          Promise.race([
            collisionChecked.promise.then(() => "checked" as const),
            aliasEntered.promise.then(() => "overtook" as const),
          ]),
        ),
      ).resolves.toBe("checked");

      flush();
      const alias = await aliasPending;
      await expect(lifetime.wait(fragment.task)).resolves.toEqual({ kind: "completed" });
      await expect(lifetime.wait(alias.task)).resolves.toEqual({ kind: "completed" });
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "x".repeat(4000),
        "/quick",
      ]);
      await expect(
        bot.prepareIngressModelAliasOwnership?.({
          update_id: 8000,
          message: { ...groupCommand("/quick", 99), from: guest },
        }),
      ).resolves.toBe(true);
    } finally {
      await lifetime.close();
    }
  });

  it("keeps a media-bearing model selection behind pending text fragments", async (context) => {
    const fragmentEntered = createDeferred<void>();
    const releaseFragment = createDeferred<void>();
    const modelEntered = createDeferred<void>();
    const fragmentText = "x".repeat(4000);
    harness.replySpy.mockImplementation(async (ctx) => {
      if (ctx.RawBody === fragmentText) {
        fragmentEntered.resolve();
        await releaseFragment.promise;
      } else if (ctx.RawBody === "/model fixture/next") {
        modelEntered.resolve();
      }
      return undefined;
    });
    const bot = createDebouncedBot(false);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const work: Promise<unknown>[] = [];
    const flushes: Array<() => void> = [];
    const lifetime = createTestLifetime(context, async () => {
      releaseFragment.resolve();
      for (const flush of flushes) {
        flush();
      }
      await Promise.allSettled(work);
      timer.mockRestore();
    });

    try {
      const fragmentUpdate = {
        update_id: 8050,
        message: ordinaryMessage(fragmentText, 99),
      };
      const fragmentPending = runWithTelegramSpooledReplayUpdate(fragmentUpdate, () =>
        bot.handleUpdate(fragmentUpdate),
      );
      work.push(fragmentPending);
      const fragment = (await lifetime.wait(fragmentPending)).deferredWork;
      if (!fragment) {
        throw new Error("Expected a durable participant for the pending fragment");
      }
      work.push(fragment.task);
      flushes.push(takeDebounceFlush(1500));

      const command = groupCommand("/model fixture/next", 99);
      const { text: caption, entities: captionEntities, ...mediaCommand } = command;
      const mediaUpdate = {
        update_id: 8051,
        message: {
          ...mediaCommand,
          caption,
          caption_entities: captionEntities,
          photo,
        },
      };
      const mediaPending = runWithTelegramSpooledReplayUpdate(mediaUpdate, () =>
        bot.handleUpdate(mediaUpdate),
      );
      work.push(mediaPending);

      await expect(
        lifetime.wait(
          Promise.race([
            fragmentEntered.promise.then(() => "fragment" as const),
            modelEntered.promise.then(() => "model" as const),
          ]),
        ),
      ).resolves.toBe("fragment");
      releaseFragment.resolve();
      await lifetime.wait(Promise.all([fragment.task, mediaPending, modelEntered.promise]));
    } finally {
      await lifetime.close();
    }
  });

  it("does not let an unauthorized colliding alias flush another sender's fragment", async (context) => {
    harness.listSkillCommandsForAgents.mockReturnValue([
      {
        name: "quick",
        skillName: "quick",
        description: "Tool command",
        dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
      },
    ]);
    const guest = { ...from, id: from.id + 1, first_name: "Grace" } as never;
    const bot = createDebouncedBot(false, [String(from.id)], [String(from.id + 1)]);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const work: Promise<unknown>[] = [];
    const flushes: Array<() => void> = [];
    const lifetime = createTestLifetime(context, async () => {
      for (const flush of flushes) {
        flush();
      }
      await Promise.allSettled(work);
      timer.mockRestore();
    });

    try {
      const fragmentUpdate = {
        update_id: 9001,
        message: ordinaryMessage("x".repeat(4000), 99),
      };
      const fragmentPending = runWithTelegramSpooledReplayUpdate(fragmentUpdate, () =>
        bot.handleUpdate(fragmentUpdate),
      );
      work.push(fragmentPending);
      const fragment = (await lifetime.wait(fragmentPending)).deferredWork;
      if (!fragment) {
        throw new Error("Expected a durable participant for the pending fragment");
      }
      work.push(fragment.task);
      const flush = takeDebounceFlush(1500);
      flushes.push(flush);

      const aliasUpdate = {
        update_id: 9002,
        message: { ...groupCommand("/quick", 99), from: guest },
      };
      await lifetime.wait(
        runWithTelegramSpooledReplayUpdate(aliasUpdate, () => bot.handleUpdate(aliasUpdate)),
      );
      expect(fragment.isSettled()).toBe(false);

      flush();
      await expect(lifetime.wait(fragment.task)).resolves.toEqual({ kind: "completed" });
    } finally {
      await lifetime.close();
    }
  });

  it("uses the current config for durable configured-alias ownership", async () => {
    const bot = createDebouncedBot(false);
    const update = { update_id: 9100, message: groupCommand("/quick", 99) };
    await expect(bot.prepareIngressModelAliasOwnership?.(update)).resolves.toBe(false);
    await expect(bot.prepareIngressModelAliasOwnership?.(update, undefined, {})).resolves.toBe(
      undefined,
    );
  });

  it("promotes persisted owner-free aliases when a skill acquires the command", async () => {
    const bot = createDebouncedBot(false);
    const update = { update_id: 9150, message: groupCommand("/quick:", 99) };
    await expect(bot.prepareIngressModelAliasOwnership?.(update)).resolves.toBe(false);

    harness.listSkillCommandsForAgents.mockReturnValue([
      {
        name: "quick",
        skillName: "quick",
        description: "Tool command",
        dispatch: { kind: "tool", toolName: "exec", argMode: "raw" },
      },
    ]);
    await expect(bot.prepareIngressModelAliasOwnership?.(update)).resolves.toBe(true);
  });

  it("keeps aliases ordinary when the host lacks worker-backed session reads", async () => {
    const sessionRuntime = getTelegramRuntime().channel.session;
    const prepareSessionEntry = sessionRuntime.prepareSessionEntry;
    delete sessionRuntime.prepareSessionEntry;
    try {
      const bot = createDebouncedBot(false);
      await expect(
        bot.prepareIngressModelAliasOwnership?.({
          update_id: 9175,
          message: groupCommand("/quick", 99),
        }),
      ).resolves.toBe(true);
    } finally {
      sessionRuntime.prepareSessionEntry = prepareSessionEntry;
    }
  });

  it("prepares cached General-topic alias ownership through the session read worker", async () => {
    await resolveTelegramForumFlag({
      chatId: -10042001,
      chatType: "supergroup",
      isGroup: true,
      isForum: true,
    });
    const prepareSessionEntry = getTelegramRuntime().channel.session.prepareSessionEntry;
    if (!prepareSessionEntry || !("mockClear" in prepareSessionEntry)) {
      throw new Error("Expected the test runtime to expose the session read worker");
    }
    const prepareSpy = vi.mocked(prepareSessionEntry);
    prepareSpy.mockClear();
    const bot = createDebouncedBot(false);
    const message = {
      ...groupCommand("/quick", 1),
      chat: { id: -10042001, type: "supergroup" as const, title: "Test group" },
      message_thread_id: undefined,
      is_topic_message: undefined,
    };

    await expect(
      bot.prepareIngressModelAliasOwnership?.({ update_id: 9200, message }),
    ).resolves.toBe(false);
    expect(prepareSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.stringContaining("topic:1") }),
    );
  });

  it.each([
    {
      label: "cold General-topic",
      message: {
        ...groupCommand("/quick", 1),
        chat: { id: -10042002, type: "supergroup" as const, title: "Cold forum" },
        message_thread_id: undefined,
        is_topic_message: undefined,
      },
    },
    {
      label: "pre-identity bot-private topic",
      message: {
        ...groupCommand("/quick", 23),
        chat: { id: 42002, type: "private" as const, first_name: "Alice" },
        is_topic_message: undefined,
      },
    },
  ])("keeps an unresolved $label alias on the ordinary lane", async ({ message }) => {
    const prepareSessionEntry = getTelegramRuntime().channel.session.prepareSessionEntry;
    if (!prepareSessionEntry || !("mockClear" in prepareSessionEntry)) {
      throw new Error("Expected the test runtime to expose the session read worker");
    }
    const prepareSpy = vi.mocked(prepareSessionEntry);
    prepareSpy.mockClear();
    const bot = createDebouncedBot(false);

    await expect(
      bot.prepareIngressModelAliasOwnership?.({ update_id: 9300, message }),
    ).resolves.toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("rejects unauthorized text controls without blocking an authorized stop in another topic", async (context) => {
    const guest = { ...from, id: from.id + 1, first_name: "Guest" };
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const stopEntered = createDeferred<void>();
    harness.replySpy.mockImplementation(async (ctx) => {
      if (ctx.RawBody === "ordinary run") {
        started.resolve();
        await release.promise;
      } else if (ctx.RawBody === "/help" && ctx.CommandAuthorized !== true) {
        // Core admission keeps unauthorized commands behind the active run.
        // Reproduce that downstream wait if Telegram fails to reject this command.
        await release.promise;
      } else if (ctx.RawBody === "/stop") {
        stopEntered.resolve();
      }
      return undefined;
    });
    const bot = createBot(false, true, {
      commands: { native: false, text: true, allowFrom: { telegram: [String(from.id)] } },
      messages: { inbound: { byChannel: { telegram: DEBOUNCE_MS } } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: [String(from.id), String(guest.id)],
          groups: { "*": { requireMention: false } },
          streaming: { mode: "off" },
        },
      },
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    const work: Promise<unknown>[] = [];
    let flush: (() => void) | undefined;
    const lifetime = createTestLifetime(context, async () => {
      release.resolve();
      flush?.();
      await Promise.allSettled(work);
      timer.mockRestore();
    });
    try {
      const update = { update_id: 6101, message: ordinaryMessage("ordinary run", 99) };
      const active = await runWithTelegramSpooledReplayUpdate(update, () =>
        bot.handleUpdate(update),
      );
      const participant = active.deferredWork;
      if (!participant) {
        throw new Error("Expected a durable participant for buffered Telegram input");
      }
      work.push(participant.task);
      flush = takeDebounceFlush();
      flush();
      await lifetime.wait(started.promise);

      const help = bot.handleUpdate({
        update_id: 6102,
        message: { ...groupCommand("/help", 99), from: guest },
      });
      work.push(help);
      const stop = bot.handleUpdate({ update_id: 6103, message: groupCommand("/stop", 100) });
      work.push(stop);
      await lifetime.wait(stopEntered.promise);
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "ordinary run",
        "/stop",
      ]);
      await lifetime.wait(Promise.all([help, stop]));
      expect(participant.isSettled()).toBe(false);
      expect(harness.replySpy.mock.calls[1]?.[0]).toMatchObject({
        CommandAuthorized: true,
        SenderId: String(from.id),
        MessageThreadId: 100,
      });

      release.resolve();
      await expect(lifetime.wait(participant.task)).resolves.toEqual({ kind: "completed" });
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "ordinary run",
        "/stop",
      ]);
    } finally {
      await lifetime.close();
    }
  });

  it("does not let an unauthorized native stop cancel buffered input", async () => {
    const bot = createDebouncedBot(true, ["99999"]);
    const timer = vi.spyOn(globalThis, "setTimeout");
    let flush: (() => void) | undefined;
    let sourceWork: Promise<unknown> | undefined;
    try {
      const update = { update_id: 6001, message: ordinaryMessage("keep this input", 99) };
      const pending = await runWithTelegramSpooledReplayUpdate(update, () =>
        bot.handleUpdate(update),
      );
      const participant = pending.deferredWork;
      if (!participant) {
        throw new Error("Expected a durable participant for buffered Telegram input");
      }
      sourceWork = participant.task;
      flush = takeDebounceFlush();

      await bot.handleUpdate({ update_id: 6002, message: groupCommand("/stop", 99) });

      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(participant.isSettled()).toBe(false);
      flush();
      await expect(participant.task).resolves.toEqual({ kind: "completed" });
      expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["keep this input"]);
    } finally {
      flush?.();
      await sourceWork;
      timer.mockRestore();
    }
  });
});
