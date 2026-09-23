import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi } from "vitest";
import type { MatrixConfig } from "../../types.js";
import type { PreviewDeliveryHarness } from "./handler.preview-delivery.test-support.js";
import type { MatrixCaseWrapper } from "./handler.test-helpers.js";

type ProgressCompletionHarness = {
  wrapCase: MatrixCaseWrapper;
  createStreamingHarness: (options: {
    streaming: "progress";
    previewToolProgressEnabled: boolean;
    accountConfig: MatrixConfig;
  }) => {
    dispatch: () => Promise<{
      opts: Pick<
        GetReplyOptions,
        "onItemEvent" | "onToolStart" | "onCommandOutput" | "onPatchSummary"
      >;
      finish: () => Promise<void>;
    }>;
  };
  sendSingleTextMessageMatrixMock: unknown;
  editMessageMatrixMock: unknown;
  singleTextMessageBody: () => unknown;
  mockCalls: (mock: unknown, label: string) => unknown[][];
  lastCallArg: (mock: unknown, argIndex: number, label: string) => unknown;
};

export function registerMatrixProgressCompletionTests(harness: ProgressCompletionHarness) {
  const {
    wrapCase,
    createStreamingHarness,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    singleTextMessageBody,
    mockCalls,
    lastCallArg,
  } = harness;
  it(
    "replaces recovered Matrix command progress instead of leaving stale failed text",
    wrapCase(async () => {
      vi.useFakeTimers();
      const { dispatch } = createStreamingHarness({
        streaming: "progress",
        previewToolProgressEnabled: true,
        accountConfig: {
          streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
        } as never,
      });
      const { opts, finish } = await dispatch();

      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-1",
          name: "exec",
          phase: "result",
          status: "failed",
          meta: "run openclaw cron -> run jq (agent) failed",
        }),
      );
      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-1",
          name: "exec",
          phase: "result",
          status: "failed",
          meta: "run openclaw cron -> run jq (agent) failed",
        }),
      );
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(singleTextMessageBody()).toContain("failed");

      await opts.onCommandOutput?.({
        itemId: "command-1",
        toolCallId: "call-1",
        phase: "end",
        name: "exec",
        status: "completed",
        exitCode: 0,
      });
      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-1",
          name: "exec",
          phase: "result",
          status: "completed",
          result: { details: { status: "completed", exitCode: 0 } },
        }),
      );

      await finish();
      expect(editMessageMatrixMock).toHaveBeenCalledWith(
        "!room:example.org",
        "$draft1",
        expect.stringContaining("Exec"),
        expect.any(Object),
      );
      const recoveredEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
        ([, eventId, body]) => eventId === "$draft1" && typeof body === "string",
      );
      expect(recoveredEdit?.[2]).not.toContain("completed");
      expect(recoveredEdit?.[2]).not.toContain("failed");
      expect(recoveredEdit?.[2]).not.toContain("run openclaw cron -> run jq");
      vi.useRealTimers();
    }),
  );

  it(
    "keeps Matrix tool progress free of terminal status text",
    wrapCase(async () => {
      vi.useFakeTimers();
      const { dispatch } = createStreamingHarness({
        streaming: "progress",
        previewToolProgressEnabled: true,
        accountConfig: {
          streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
        } as never,
      });
      const { opts, finish } = await dispatch();

      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-2",
          name: "exec",
          phase: "start",
          args: { command: "npm install" },
        }),
      );
      await opts.onToolStart?.({
        toolCallId: "call-2",
        name: "exec",
        phase: "start",
        args: { command: "npm install" },
      });
      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-2",
          name: "exec",
          phase: "update",
          args: { command: "npm install" },
        }),
      );
      await opts.onToolStart?.({
        itemId: "fc-call-2",
        toolCallId: "call-2",
        name: "exec",
        phase: "update",
        args: { command: "npm install" },
      });
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(singleTextMessageBody()).toContain("Exec");

      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-2",
          name: "exec",
          phase: "update",
          meta: "install dependencies",
        }),
      );

      await opts.onCommandOutput?.({
        itemId: "fc-call-2-output",
        toolCallId: "call-2",
        phase: "end",
        name: "exec",
        status: "completed",
        exitCode: 0,
      });

      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-2",
          name: "exec",
          phase: "result",
          status: "completed",
          result: { details: { status: "completed", exitCode: 0 } },
        }),
      );
      await finish();
      const completedEdit = mockCalls(editMessageMatrixMock, "editMessageMatrix").find(
        ([, eventId, body]) =>
          eventId === "$draft1" && typeof body === "string" && body.includes("completed"),
      );
      expect(completedEdit).toBeUndefined();
      expect(singleTextMessageBody()).toContain("Exec");
      vi.useRealTimers();
    }),
  );

  it(
    "replaces the running Matrix patch row with its prepared completion",
    wrapCase(async () => {
      vi.useFakeTimers();
      const { dispatch } = createStreamingHarness({
        streaming: "progress",
        previewToolProgressEnabled: true,
        accountConfig: {
          streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
        } as never,
      });
      const { opts, finish } = await dispatch();

      await opts.onItemEvent?.(
        projectAgentToolActivity({ toolCallId: "call-3", name: "apply_patch", phase: "update" }),
      );
      await opts.onItemEvent?.(
        projectAgentToolActivity({ toolCallId: "call-3", name: "apply_patch", phase: "update" }),
      );
      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(singleTextMessageBody()).toContain("Apply Patch: running");

      await opts.onPatchSummary?.({
        itemId: "patch:call-3",
        toolCallId: "call-3",
        phase: "end",
        name: "apply_patch",
        modified: ["extensions/matrix/src/matrix/monitor/handler.ts"],
        summary: "1 file modified",
      });

      await opts.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "call-3",
          name: "apply_patch",
          phase: "result",
          status: "completed",
          result: {
            details: {
              summary: {
                added: [],
                modified: ["extensions/matrix/src/matrix/monitor/handler.ts"],
                deleted: [],
              },
            },
          },
        }),
      );
      await finish();
      const patchEdit = lastCallArg(editMessageMatrixMock, 2, "Matrix completed patch body");
      expect(patchEdit).toBe("Working\n\n`🩹 Apply Patch`");
      vi.useRealTimers();
    }),
  );
}

type TtsPreviewHarness = PreviewDeliveryHarness & {
  expectEditLiveFlag: (eventId: string, text: string, live: boolean | undefined) => void;
  requireRecord: (value: unknown, label: string) => Record<string, unknown>;
  callArg: (mock: unknown, callIndex: number, argIndex: number, label: string) => unknown;
};

export function registerMatrixTtsPreviewDeliveryTests(harness: TtsPreviewHarness) {
  const {
    wrapCase,
    createStreamingHarness,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    deliverMatrixRepliesMock,
    waitForMatrixState,
    expectEditLiveFlag,
    requireRecord,
    callArg,
  } = harness;
  it(
    "keeps the draft preview and sends media-only for TTS supplement finals",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Spoken answer" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      const result = await deliver(
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
        { kind: "final" },
      );

      expectEditLiveFlag("$draft1", "Spoken answer", false);
      expect(redactEventMock).not.toHaveBeenCalled();
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      expect(
        requireRecord(
          callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
          "deliver replies params",
        ).replies,
      ).toEqual([
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ]);
      expect(result).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$draft1", "$reply1"],
            visibleReplySent: true,
            content: "Spoken answer\ndelivered",
            receipt: { primaryPlatformMessageId: "$draft1" },
          },
        },
      });
      await finish();
    }),
  );

  it(
    "preserves a finalized draft receipt when the following media send fails",
    wrapCase(async () => {
      const { dispatch } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Spoken answer" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("media send failed"));

      const error = await deliver(
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
        { kind: "final" },
      );

      expect(error).toMatchObject({
        delivery: {
          kind: "failed",
          error: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: {
              messageIds: ["$draft1"],
              visibleReplySent: true,
              content: "Spoken answer",
              receipt: { primaryPlatformMessageId: "$draft1" },
            },
          },
        },
      });
      await finish();
    }),
  );

  it(
    "falls back with visible text when TTS supplement live finalization fails",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Spoken answer" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));
      await deliver(
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
        { kind: "final" },
      );

      expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      expect(
        requireRecord(
          callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
          "deliver replies params",
        ).replies,
      ).toEqual([
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ]);
      await finish();
    }),
  );

  it(
    "falls back with visible text when TTS supplement preview has no event id",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      const { deliver, finish } = await dispatch();

      await deliver(
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
        { kind: "final" },
      );

      expect(redactEventMock).not.toHaveBeenCalled();
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      expect(
        requireRecord(
          callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
          "deliver replies params",
        ).replies,
      ).toEqual([
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ]);
      await finish();
    }),
  );

  it(
    "keeps already-delivered TTS supplements audio-only without a draft preview",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "off",
      });
      const { deliver, finish } = await dispatch();

      await deliver(
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: {
            spokenText: "Spoken answer",
            visibleTextAlreadyDelivered: true,
          },
        },
        { kind: "final" },
      );

      expect(redactEventMock).not.toHaveBeenCalled();
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      expect(
        requireRecord(
          callArg(deliverMatrixRepliesMock, 0, 0, "deliver replies params"),
          "deliver replies params",
        ).replies,
      ).toEqual([
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: {
            spokenText: "Spoken answer",
            visibleTextAlreadyDelivered: true,
          },
        },
      ]);
      await finish();
    }),
  );
}
