import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi, type Mock } from "vitest";
import type { MatrixCaseWrapper, MatrixQueuedDelivery } from "./handler.test-helpers.js";
import type { MatrixReplyDeliveryResult } from "./replies.js";

export type PreviewDeliveryHarness = {
  wrapCase: MatrixCaseWrapper;
  createStreamingHarness: (options?: {
    streaming?: "partial" | "quiet" | "progress" | "off";
    previewToolProgressEnabled?: boolean;
    blockStreamingEnabled?: boolean;
  }) => {
    dispatch: () => Promise<{
      deliver: (
        payload: ReplyPayload,
        info: { kind: "tool" | "block" | "final" },
      ) => Promise<MatrixQueuedDelivery>;
      opts: GetReplyOptions;
      finish: () => Promise<void>;
    }>;
    redactEventMock: Mock;
  };
  createMockMatrixDeliveryResult: (
    messageId?: string,
    content?: string,
  ) => MatrixReplyDeliveryResult;
  sendSingleTextMessageMatrixMock: Mock;
  editMessageMatrixMock: Mock;
  deliverMatrixRepliesMock: Mock;
  waitForMatrixState: (assertion: () => void) => Promise<void>;
  mockCalls: (mock: unknown, label: string) => unknown[][];
};

export function registerMatrixPreviewDeliveryTests(harness: PreviewDeliveryHarness) {
  const {
    wrapCase,
    createStreamingHarness,
    createMockMatrixDeliveryResult,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    deliverMatrixRepliesMock,
    waitForMatrixState,
    mockCalls,
  } = harness;
  it(
    "redacts stale draft for media-only finals",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness();
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Partial reply" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      deliverMatrixRepliesMock.mockClear();
      await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });

      expect(editMessageMatrixMock).not.toHaveBeenCalled();
      expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      await finish();
    }),
  );

  it(
    "retires a preview after source delivery and ignores late progress",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        streaming: "partial",
        previewToolProgressEnabled: true,
      });
      const { opts, finish } = await dispatch();
      try {
        await opts.onPartialReply?.({ text: "Visible preview" });
        await waitForMatrixState(() => {
          expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
        });
        await opts.onObservedReplyDelivery?.();
        await opts.onPartialReply?.({ text: "Late model delta" });
        await opts.onItemEvent?.({
          itemId: "late-tool",
          kind: "tool",
          name: "exec",
          status: "running",
          progressText: "late progress",
        });
      } finally {
        await finish();
      }
      expect(redactEventMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", "$draft1");
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(editMessageMatrixMock).not.toHaveBeenCalled();
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
    }),
  );

  it(
    "preserves a surviving draft receipt when redaction and media delivery fail",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
      deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("media send failed"));
      const error = await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });

      expect(error).toMatchObject({
        accepted: true,
        receipt: { anyVisibleDelivered: true, counts: { final: { failedAfterSend: 1 } } },
        delivery: {
          kind: "failed",
          error: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: {
              messageIds: ["$draft1"],
              visibleReplySent: true,
              content: "Visible preview",
              receipt: { primaryPlatformMessageId: "$draft1" },
            },
          },
        },
      });
      await finish();
    }),
  );

  it(
    "preserves a surviving draft receipt when final-edit fallback also fails",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
      deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
      const error = await deliver({ text: "Final text" }, { kind: "final" });

      expect(error).toMatchObject({
        delivery: {
          kind: "failed",
          error: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: {
              messageIds: ["$draft1"],
              visibleReplySent: true,
              content: "Visible preview",
              receipt: { primaryPlatformMessageId: "$draft1" },
            },
          },
        },
      });
      await finish();
    }),
  );

  it(
    "preserves a surviving draft receipt when generic fallback delivery fails",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
      deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
      const error = await deliver({ text: "Something failed", isError: true } as never, {
        kind: "final",
      });

      expect(error).toMatchObject({
        delivery: {
          kind: "failed",
          error: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: {
              messageIds: ["$draft1"],
              visibleReplySent: true,
              content: "Visible preview",
              receipt: { primaryPlatformMessageId: "$draft1" },
            },
          },
        },
      });
      await finish();
    }),
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "retains a visible draft when $branch replacement throws",
    wrapCase(async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));

      const error = await deliver(payload, { kind: "final" });

      expect(error).toMatchObject({
        delivery: {
          kind: "failed",
          error: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: {
              messageIds: ["$draft1"],
              visibleReplySent: true,
              content: "Visible preview",
            },
          },
        },
      });
      expect(redactEventMock).not.toHaveBeenCalled();
      await finish();
      expect(redactEventMock).not.toHaveBeenCalled();
    }),
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "retains a visible draft when $branch replacement reports no visible event",
    wrapCase(async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockResolvedValueOnce({
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      });

      const result = await deliver(payload, { kind: "final" });
      await finish();

      expect(result).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$draft1"],
            visibleReplySent: true,
            content: "Visible preview",
          },
        },
      });
      expect(redactEventMock).not.toHaveBeenCalled();
    }),
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "redacts a visible draft only after complete $branch replacement",
    wrapCase(async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }

      const result = await deliver(payload, { kind: "final" });

      expect(result).toMatchObject({
        delivery: { kind: "delivered", value: { messageIds: ["$reply1"], visibleReplySent: true } },
      });
      expect(deliverMatrixRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
        redactEventMock.mock.invocationCallOrder[0]!,
      );
      expect(redactEventMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", "$draft1");
      await finish();
      expect(redactEventMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "combines a visible draft with accepted $branch replacement prefixes",
    wrapCase(async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockRejectedValueOnce(
        createChannelPartialDeliveryError(new Error("second replacement event failed"), {
          ...createMockMatrixDeliveryResult("$accepted-prefix", "Accepted prefix"),
          visibleReplySent: true as const,
        }),
      );

      const error = await deliver(payload, { kind: "final" });

      expect(error).toMatchObject({
        delivery: {
          kind: "failed",
          error: {
            code: "CHANNEL_PARTIAL_DELIVERY",
            deliveryResult: {
              messageIds: ["$draft1", "$accepted-prefix"],
              visibleReplySent: true,
              content: "Visible preview\nAccepted prefix",
            },
          },
        },
      });
      expect(redactEventMock).not.toHaveBeenCalled();
      await finish();
      expect(redactEventMock).not.toHaveBeenCalled();
    }),
  );

  it(
    "preserves accepted replacement receipts and retries failed preview redaction",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));

      const result = await deliver({ text: "Something failed", isError: true }, { kind: "final" });

      expect(result).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$draft1", "$reply1"],
            visibleReplySent: true,
            content: "Visible preview\ndelivered",
          },
        },
      });
      deliverMatrixRepliesMock.mockResolvedValueOnce(
        createMockMatrixDeliveryResult("$reply2", "Later durable reply"),
      );
      const laterResult = await deliver({ text: "Later durable reply" }, { kind: "final" });
      expect(laterResult).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$reply2"],
            visibleReplySent: true,
            content: "Later durable reply",
          },
        },
      });
      expect(editMessageMatrixMock).not.toHaveBeenCalled();
      await finish();
      expect(mockCalls(redactEventMock, "redactEvent").map(([, id]) => id)).toEqual([
        "$draft1",
        "$draft1",
      ]);
    }),
  );

  it.each(
    (["retained", "consumed"] as const).flatMap((priorDisposition) =>
      (["block", "followup"] as const).flatMap((boundary) =>
        (["complete", "unfinished"] as const).map((outcome) => ({
          priorDisposition,
          boundary,
          outcome,
        })),
      ),
    ),
  )(
    "settles $priorDisposition then $boundary draft generations through $outcome",
    wrapCase(async ({ priorDisposition, boundary, outcome }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "First generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (priorDisposition === "retained") {
        deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));
      }
      if (boundary === "block") {
        await opts.onBlockReplyQueued?.({ text: "First generation" });
      }
      const firstDelivery = deliver(
        { text: "First replacement", isError: true },
        { kind: boundary === "block" ? "block" : "final" },
      );
      const firstOutcome = await firstDelivery;
      expect(firstOutcome.delivery?.kind).toBe(
        priorDisposition === "retained" ? "failed" : "delivered",
      );
      if (boundary === "followup") {
        await opts.onQueuedFollowupAdmitted?.();
      } else {
        await opts.onAssistantMessageStart?.();
      }

      sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
        messageId: "$draft2",
        roomId: "!room",
      });
      await opts.onPartialReply?.({ text: "Next generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
      });
      if (outcome === "complete") {
        await deliver({ text: "Second replacement", isError: true }, { kind: "final" });
      }
      await finish();

      const redactedEventIds = mockCalls(redactEventMock, "redactEvent").map(
        ([, eventId]) => eventId,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft1")).toHaveLength(
        priorDisposition === "consumed" ? 1 : 0,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft2")).toHaveLength(1);
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(outcome === "complete" ? 2 : 1);
      if (outcome === "complete") {
        expect(deliverMatrixRepliesMock.mock.invocationCallOrder[1]).toBeLessThan(
          redactEventMock.mock.invocationCallOrder.at(-1)!,
        );
      }
    }),
  );
}

type PreviewPreparationHarness = PreviewDeliveryHarness & {
  prepareMatrixSingleTextMock: Mock;
  getGlobalHookRunnerMock: Mock;
  expectFinalizedPreviewEdit: (eventId: string, text: string) => void;
  expectEditLiveFlag: (eventId: string, text: string, live: boolean | undefined) => void;
};

export function registerMatrixPreviewPreparationTests(harness: PreviewPreparationHarness) {
  const {
    wrapCase,
    createStreamingHarness,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    deliverMatrixRepliesMock,
    waitForMatrixState,
    prepareMatrixSingleTextMock,
    getGlobalHookRunnerMock,
    expectFinalizedPreviewEdit,
    expectEditLiveFlag,
  } = harness;
  it(
    "finalizes a single quiet-preview block in place when block streaming is enabled",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({ blockStreamingEnabled: true });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Single block" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      deliverMatrixRepliesMock.mockClear();
      const result = await deliver({ text: "Single block" }, { kind: "final" });

      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expectFinalizedPreviewEdit("$draft1", "Single block");
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      expect(redactEventMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$draft1"],
            visibleReplySent: true,
            content: "Single block",
            receipt: { primaryPlatformMessageId: "$draft1" },
          },
        },
      });
      await finish();
    }),
  );

  it(
    "settles finalized previews with provider-prepared content",
    wrapCase(async () => {
      prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
        trimmedText: text.trim(),
        convertedText: `prepared:${text.trim()}`,
        singleEventLimit: 4000,
        fitsInSingleEvent: true,
      }));
      const { dispatch } = createStreamingHarness({ streaming: "quiet" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Raw preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      const result = await deliver({ text: "Raw final" }, { kind: "final" });

      expect(result).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$draft1"],
            content: "prepared:Raw final",
          },
        },
      });
      await finish();
    }),
  );

  it(
    "settles reused media previews with provider-prepared content",
    wrapCase(async () => {
      prepareMatrixSingleTextMock.mockImplementation((text: string) => ({
        trimmedText: text.trim(),
        convertedText: `prepared:${text.trim()}`,
        singleEventLimit: 4000,
        fitsInSingleEvent: true,
      }));
      const { dispatch } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Raw caption" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      const result = await deliver(
        { text: "Raw caption", mediaUrl: "https://example.com/image.png" },
        { kind: "final" },
      );

      expect(result).toMatchObject({
        delivery: {
          kind: "delivered",
          value: {
            messageIds: ["$draft1", "$reply1"],
            content: "prepared:Raw caption\ndelivered",
          },
        },
      });
      await finish();
    }),
  );

  it(
    "preserves provider previews for observer-only hooks",
    wrapCase(async () => {
      getGlobalHookRunnerMock.mockReturnValue({
        hasHooks: vi.fn((hookName: string) => hookName === "message_sent"),
      });
      const { dispatch } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      await deliver({ text: "Visible preview" }, { kind: "final" });

      expectEditLiveFlag("$draft1", "Visible preview", false);
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      await finish();
    }),
  );

  it.each([
    { label: "reply_payload_sending", hooks: ["reply_payload_sending"] },
    { label: "message_sending", hooks: ["message_sending"] },
    {
      label: "both modifying hooks",
      hooks: ["reply_payload_sending", "message_sending"],
    },
  ])(
    "suppresses provider previews when $label is registered",
    wrapCase(async ({ hooks }) => {
      const registered = new Set(hooks);
      getGlobalHookRunnerMock.mockReturnValue({
        hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
      });
      const { dispatch } = createStreamingHarness({
        previewToolProgressEnabled: true,
        streaming: "progress",
      });
      const { deliver, opts, finish } = await dispatch();

      expect(opts.onPartialReply).toBeUndefined();
      expect(opts.onToolStart).toBeUndefined();
      expect(opts.suppressDefaultToolProgressMessages).toBeUndefined();
      await deliver({ text: "Durable final" }, { kind: "final" });

      expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
      expect(editMessageMatrixMock).not.toHaveBeenCalled();
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
      await finish();
    }),
  );

  it(
    "still edits partial preview-first drafts when the final text changes",
    wrapCase(async () => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        blockStreamingEnabled: true,
        streaming: "partial",
      });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Single" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      await deliver({ text: "Single block" }, { kind: "final" });

      expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
      expectEditLiveFlag("$draft1", "Single block", undefined);
      expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
      expect(redactEventMock).not.toHaveBeenCalled();
      await finish();
    }),
  );
}
