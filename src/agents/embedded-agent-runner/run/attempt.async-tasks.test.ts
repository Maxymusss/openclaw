// Coverage for waiting on completion-required async tool tasks.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearGeneratedMediaTaskActivity,
  createMediaGenerationOperation,
  resetGeneratedMediaTaskActivityForTests,
  updateMediaGenerationOperation,
  type MediaGenerationOperation,
} from "../../media-generation-activity.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type AsyncStartedToolMeta,
} from "./attempt-async-tasks.js";

function createMediaOperation(
  params: Omit<MediaGenerationOperation, "taskId" | "status" | "createdAt"> & { runId: string },
) {
  return createMediaGenerationOperation({
    ...params,
    taskId: params.runId,
    status: "running",
    createdAt: params.startedAt ?? Date.now(),
  });
}
function completeMediaOperation(params: {
  runId: string;
  sessionKey?: string;
  endedAt: number;
  lastEventAt?: number;
  progressSummary?: string;
  terminalSummary?: string;
}) {
  updateMediaGenerationOperation(params.runId, {
    status: "succeeded",
    endedAt: params.endedAt,
    lastEventAt: params.lastEventAt,
    progressSummary: params.progressSummary,
    terminalSummary: params.terminalSummary,
  });
  clearGeneratedMediaTaskActivity(params.runId);
}

function requireCreatedTask(task: MediaGenerationOperation | null): MediaGenerationOperation {
  // The wait must observe the exact native operation; tests require
  // a concrete active record before waiting.
  if (!task) {
    throw new Error("expected test task to be created");
  }
  return task;
}

function createPendingDeadlineTask() {
  const sessionKey = "agent:main:cron:deadline-media:run:run-deadline";
  const runId = "tool:image_generate:run-deadline";
  requireCreatedTask(
    createMediaOperation({
      taskKind: "image_generation",
      sourceId: "image_generate:test",
      requesterSessionKey: sessionKey,
      runId,
      task: "deadline image",
      startedAt: 1,
      lastEventAt: 1,
    }),
  );
  return { sessionKey, runId };
}

describe("waitForCompletionRequiredAsyncTasks", () => {
  beforeAll(() => resetGeneratedMediaTaskActivityForTests());
  // Aborted and timed-out waits leave tasks running; release them before the next suite.
  afterEach(() => resetGeneratedMediaTaskActivityForTests());

  it("waits for async task ids discovered during the attempt", async () => {
    // Tool metadata is the primary source for async task ids produced during
    // the current attempt.
    const task = requireCreatedTask(
      createMediaOperation({
        taskKind: "image_generation",
        sourceId: "image_generate:openai",
        requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
        runId: "tool:image_generate:run-123",
        task: "daily image",
        startedAt: 1,
        lastEventAt: 1,
      }),
    );
    const metas: AsyncStartedToolMeta[] = [
      {
        toolName: "image_generate",
        asyncStarted: true,
        asyncTaskRunId: "tool:image_generate:run-123",
        asyncTaskId: task.taskId,
      },
    ];

    const deadlineAtMs = Date.now() + 10_000;
    const waitPromise = waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => metas,
      getDeadlineAtMs: () => deadlineAtMs,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    completeMediaOperation({
      runId: "tool:image_generate:run-123",
      sessionKey: "agent:main:cron:daily-media:run:run-123",
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Generated 1 image",
      terminalSummary: "Generated 1 image.",
    });

    await expect(waitPromise).resolves.toMatchObject({
      waitedRunIds: ["tool:image_generate:run-123"],
      timedOutRunIds: [],
    });
  });

  it("requires a wait when the cron run has an active tracked media task", () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createMediaOperation({
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: sessionKey,
      runId: "tool:image_generate:run-123",
      task: "daily image",
      startedAt: 1,
      lastEventAt: 1,
    });

    expect(
      requiresCompletionRequiredAsyncTaskWait({
        sessionKey,
        toolMetas: [],
      }),
    ).toBe(true);
  });

  it("skips media task waiting after sessions_yield pauses the attempt", () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createMediaOperation({
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: sessionKey,
      runId: "tool:image_generate:run-123",
      task: "daily image",
      startedAt: 1,
      lastEventAt: 1,
    });

    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskRunId: "tool:image_generate:run-123",
          },
        ],
        yieldDetected: true,
      }),
    ).toBe(false);
    expect(
      shouldWaitForCompletionRequiredAsyncTasks({
        sessionKey,
        toolMetas: [],
        yieldDetected: false,
      }),
    ).toBe(true);
  });

  it("waits for active cron media tasks from native media operations", async () => {
    // Cron media tools may start tasks before metadata is flushed, so the
    // registry is also consulted by session key.
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createMediaOperation({
      taskKind: "image_generation",
      sourceId: "image_generate:openai",
      requesterSessionKey: sessionKey,
      runId: "tool:image_generate:run-123",
      task: "daily image",
      startedAt: 1,
      lastEventAt: 1,
    });

    const deadlineAtMs = Date.now() + 10_000;
    const waitPromise = waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => [],
      sessionKey,
      getDeadlineAtMs: () => deadlineAtMs,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    completeMediaOperation({
      runId: "tool:image_generate:run-123",
      sessionKey,
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Generated 1 image",
      terminalSummary: "Generated 1 image.",
    });

    await expect(waitPromise).resolves.toMatchObject({
      waitedRunIds: ["tool:image_generate:run-123"],
      timedOutRunIds: [],
    });
  });

  it("waits for active cron video tasks from native media operations", async () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    createMediaOperation({
      taskKind: "video_generation",
      sourceId: "video_generate:fal",
      requesterSessionKey: sessionKey,
      runId: "tool:video_generate:run-123",
      task: "daily video",
      startedAt: 1,
      lastEventAt: 1,
    });

    const deadlineAtMs = Date.now() + 10_000;
    const waitPromise = waitForCompletionRequiredAsyncTasks({
      getToolMetas: () => [],
      sessionKey,
      getDeadlineAtMs: () => deadlineAtMs,
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    completeMediaOperation({
      runId: "tool:video_generate:run-123",
      sessionKey,
      endedAt: Date.now(),
      lastEventAt: Date.now(),
      progressSummary: "Generated 1 video",
      terminalSummary: "Generated 1 video.",
    });

    await expect(waitPromise).resolves.toMatchObject({
      waitedRunIds: ["tool:video_generate:run-123"],
      timedOutRunIds: [],
    });
  });

  it("waits for async task ids discovered after an earlier async completion", async () => {
    const sessionKey = "agent:main:cron:daily-media:run:run-123";
    const imageTask = requireCreatedTask(
      createMediaOperation({
        taskKind: "image_generation",
        sourceId: "image_generate:openai",
        requesterSessionKey: sessionKey,
        runId: "tool:image_generate:run-123",
        task: "daily image",
        startedAt: 1,
        lastEventAt: 1,
      }),
    );
    const metas: AsyncStartedToolMeta[] = [
      {
        toolName: "image_generate",
        asyncStarted: true,
        asyncTaskRunId: "tool:image_generate:run-123",
        asyncTaskId: imageTask.taskId,
      },
    ];
    let now = 1;
    let pollCount = 0;

    await expect(
      waitForCompletionRequiredAsyncTasks({
        getToolMetas: () => metas,
        getDeadlineAtMs: () => 20,
        now: () => now,
        sleep: async (ms) => {
          pollCount += 1;
          now += ms;
          if (pollCount === 1) {
            completeMediaOperation({
              runId: "tool:image_generate:run-123",
              sessionKey,
              endedAt: now,
              lastEventAt: now,
              progressSummary: "Generated 1 image",
              terminalSummary: "Generated 1 image.",
            });
            const musicTask = requireCreatedTask(
              createMediaOperation({
                taskKind: "music_generation",
                sourceId: "music_generate:fal",
                requesterSessionKey: sessionKey,
                runId: "tool:music_generate:run-456",
                task: "daily track",
                startedAt: now,
                lastEventAt: now,
              }),
            );
            metas.push({
              toolName: "music_generate",
              asyncStarted: true,
              asyncTaskRunId: "tool:music_generate:run-456",
              asyncTaskId: musicTask.taskId,
            });
          } else if (pollCount === 2) {
            completeMediaOperation({
              runId: "tool:music_generate:run-456",
              sessionKey,
              endedAt: now,
              lastEventAt: now,
              progressSummary: "Generated music",
              terminalSummary: "Generated music.",
            });
          }
        },
        pollIntervalMs: 2,
      }),
    ).resolves.toMatchObject({
      waitedRunIds: ["tool:image_generate:run-123", "tool:music_generate:run-456"],
      timedOutRunIds: [],
    });
  });

  it("reports tasks that do not finish before the deadline", async () => {
    createMediaOperation({
      taskKind: "music_generation",
      sourceId: "music_generate:test",
      requesterSessionKey: "agent:main:cron:daily-media:run:run-123",
      runId: "tool:music_generate:run-123",
      task: "daily track",
      startedAt: 1,
      lastEventAt: 1,
    });
    let now = 1;

    await expect(
      waitForCompletionRequiredAsyncTasks({
        getToolMetas: () => [
          {
            toolName: "music_generate",
            asyncStarted: true,
            asyncTaskRunId: "tool:music_generate:run-123",
          },
        ],
        getDeadlineAtMs: () => 5,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        pollIntervalMs: 2,
      }),
    ).resolves.toMatchObject({
      waitedRunIds: ["tool:music_generate:run-123"],
      timedOutRunIds: ["tool:music_generate:run-123"],
    });
  });

  it("keeps unlimited task waiting on bounded polls beyond the former finite sentinel", async () => {
    const { sessionKey, runId } = createPendingDeadlineTask();
    let now = MAX_TIMER_TIMEOUT_MS + 1;
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBe(500);
      now += ms;
      completeMediaOperation({
        runId,
        sessionKey,
        endedAt: now,
        lastEventAt: now,
        progressSummary: "Generated image",
        terminalSummary: "Generated image.",
      });
    });
    const input = {
      getToolMetas: () => [],
      sessionKey,
      getDeadlineAtMs: () => undefined,
      now: () => now,
      sleep,
      pollIntervalMs: 500,
    };

    await expect(waitForCompletionRequiredAsyncTasks(input)).resolves.toMatchObject({
      waitedRunIds: [runId],
      timedOutRunIds: [],
    });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500);
  });

  it("rereads pause and resume deadlines once per task poll", async () => {
    const { sessionKey, runId } = createPendingDeadlineTask();
    let now = 0;
    let deadlineAtMs: number | undefined = 750;
    const expectedSleeps = [500, 500, 500, 250];
    let polls = 0;
    const getDeadlineAtMs = vi.fn(() => deadlineAtMs);
    const input = {
      getToolMetas: () => [],
      sessionKey,
      getDeadlineAtMs,
      now: () => now,
      pollIntervalMs: 500,
      sleep: async (ms: number) => {
        expect(ms).toBe(expectedSleeps[polls]);
        now += ms;
        polls += 1;
        if (polls === 1) {
          deadlineAtMs = undefined;
        } else if (polls === 3) {
          deadlineAtMs = now + 250;
        }
      },
    };

    await expect(waitForCompletionRequiredAsyncTasks(input)).resolves.toMatchObject({
      waitedRunIds: [runId],
      timedOutRunIds: [runId],
    });
    expect(now).toBe(1_750);
    expect(polls).toBe(expectedSleeps.length);
    expect(getDeadlineAtMs).toHaveBeenCalledTimes(5);
  });

  it.each([5_000, undefined])(
    "stops an in-flight task poll promptly on abort (deadline=%s)",
    async (deadlineAtMs) => {
      const { sessionKey } = createPendingDeadlineTask();
      const controller = new AbortController();
      const reason = new Error("run cancelled during task poll");
      const input = {
        getToolMetas: () => [],
        sessionKey,
        getDeadlineAtMs: () => deadlineAtMs,
        now: () => 0,
        abortSignal: controller.signal,
        sleep: async (ms: number) => {
          expect(ms).toBe(500);
          controller.abort(reason);
          await new Promise<void>(() => {});
        },
        pollIntervalMs: 500,
      };

      await expect(waitForCompletionRequiredAsyncTasks(input)).rejects.toMatchObject({
        name: "AbortError",
        cause: reason,
      });
    },
  );
});
