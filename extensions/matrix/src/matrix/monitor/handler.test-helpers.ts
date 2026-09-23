// Matrix helper module supports handler helpers behavior.
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  finalizeInboundContext as finalizeCoreInboundContext,
  resetInboundDedupe,
  settleReplyDispatcher,
} from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { createFixtureLifetime } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { it, vi } from "vitest";
import type {
  MatrixConfig,
  MatrixRoomConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import { EventType, type MatrixRawEvent, type RoomMessageEventContent } from "./types.js";

type MatrixMonitorHandlerParams = Parameters<typeof createMatrixRoomMessageHandler>[0];
type MatrixTurn = ChannelInboundTurnPlan;
export type MatrixReplyScript = NonNullable<MatrixTurn["dispatchReplyFromConfig"]>;
type MatrixRecordedTurn = {
  ctx: MatrixTurn["ctxPayload"];
  sessionKey?: string;
  storePath: string;
  updateLastRoute?: NonNullable<MatrixTurn["record"]>["updateLastRoute"];
};
export type MatrixDeliveryObservation =
  | { kind: "delivered"; value: unknown }
  | { kind: "failed"; error: unknown };

export type MatrixQueuedDelivery = {
  accepted: boolean;
  receipt: Awaited<ReturnType<Parameters<MatrixReplyScript>[0]["dispatcher"]["waitForIdle"]>>;
  delivery?: MatrixDeliveryObservation;
};

type MatrixCase = {
  state: OpenClawTestState;
  signal: AbortSignal;
  lifetime: ReturnType<typeof createFixtureLifetime>;
  releases: Set<() => void>;
  metadata: Set<Promise<unknown>>;
  metadataErrors: unknown[];
  failed: boolean;
  releasing: boolean;
};
let activeCase: MatrixCase | undefined;

function currentCase(): MatrixCase {
  if (!activeCase) {
    throw new Error("Matrix handler work must run inside its owned test case");
  }
  return activeCase;
}

export function matrixCaseConfig(cfg: unknown = {}): MatrixTurn["cfg"] {
  const config = cfg as MatrixTurn["cfg"];
  return {
    ...config,
    session: {
      ...config.session,
      store:
        config.session?.store ??
        currentCase().state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
    },
  };
}

export function registerMatrixTestRelease(release: () => void): void {
  const owner = currentCase();
  owner.releases.add(release);
  if (owner.signal.aborted || owner.releasing) {
    release();
  }
}

export async function waitForMatrixTestSignal<T>(
  ready: Promise<T>,
  producer: Promise<unknown>,
): Promise<T> {
  const { signal } = currentCase();
  signal.throwIfAborted();
  let remove = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([
      ready,
      producer.then(() => {
        throw new Error("Matrix producer settled before readiness");
      }),
      cancelled,
    ]);
  } finally {
    remove();
  }
}

export function installMatrixHandlerTestFixture() {
  const cleanups: Array<() => void | Promise<void>> = [];
  it.aroundEach(async (runTest, context) => {
    context.signal.throwIfAborted();
    await withOpenClawTestState({ label: "matrix-handler" }, async (state) => {
      const owner: MatrixCase = {
        state,
        signal: context.signal,
        lifetime: createFixtureLifetime(),
        releases: new Set(),
        metadata: new Set(),
        metadataErrors: [],
        failed: false,
        releasing: false,
      };
      activeCase = owner;
      const cleanupErrors: unknown[] = [];
      const release = () => {
        owner.releasing = true;
        for (const callback of owner.releases) {
          try {
            callback();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      };
      context.signal.addEventListener("abort", release, { once: true });
      if (context.signal.aborted) {
        release();
      }
      try {
        await runTest();
      } catch (error) {
        owner.failed = true;
        throw error;
      } finally {
        release();
        try {
          // A Vitest timeout can finish runTest before the actual callback unwinds.
          await owner.lifetime.cleanup();
          const metadata = await Promise.allSettled(owner.metadata);
          cleanupErrors.push(
            ...metadata.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          );
          for (const cleanup of cleanups) {
            try {
              await cleanup();
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          resetInboundDedupe();
          cleanupErrors.push(...owner.metadataErrors);
          if (
            !owner.failed &&
            !context.signal.aborted &&
            context.task.result?.state !== "fail" &&
            cleanupErrors.length
          ) {
            throw new AggregateError(cleanupErrors, "Matrix fixture cleanup or metadata failed");
          }
        } finally {
          context.signal.removeEventListener("abort", release);
          activeCase = undefined;
        }
      }
    });
  });
  return {
    get state() {
      return currentCase().state;
    },
    get signal() {
      return currentCase().signal;
    },
    afterEach(cleanup: () => void | Promise<void>) {
      cleanups.push(cleanup);
    },
    wrapCase<Args extends unknown[], Result>(body: (...args: Args) => Promise<Result>) {
      return (...args: Args) => {
        const owner = currentCase();
        return owner.lifetime.run(async () => {
          try {
            return await body(...args);
          } catch (error) {
            owner.failed = true;
            throw error;
          }
        });
      };
    },
    joinCase() {
      return currentCase().lifetime.cleanup();
    },
    async waitForMetadata() {
      await Promise.all(currentCase().metadata);
    },
  };
}

export type MatrixCaseWrapper = ReturnType<typeof installMatrixHandlerTestFixture>["wrapCase"];

const DEFAULT_ROUTE = {
  agentId: "ops",
  channel: "matrix",
  accountId: "ops",
  sessionKey: "agent:ops:main",
  mainSessionKey: "agent:ops:main",
  matchedBy: "binding.account" as const,
};

type MatrixHandlerTestHarnessOptions = {
  system?: Pick<MatrixMonitorHandlerParams["core"]["system"], "enqueueSystemEvent">;
  accountId?: string;
  accountConfig?: MatrixConfig;
  cfg?: unknown;
  liveCfg?: unknown;
  client?: Partial<MatrixClient>;
  runtime?: RuntimeEnv;
  logger?: RuntimeLogger;
  currentConfig?: () => unknown;
  logVerboseMessage?: (message: string) => void;
  allowFrom?: string[];
  allowFromResolvedEntries?: MatrixMonitorHandlerParams["allowFromResolvedEntries"];
  groupAllowFrom?: string[];
  groupAllowFromResolvedEntries?: MatrixMonitorHandlerParams["groupAllowFromResolvedEntries"];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: Set<string>;
  mentionRegexes?: RegExp[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  replyToMode?: ReplyToMode;
  threadReplies?: "off" | "inbound" | "always";
  dmThreadReplies?: "off" | "inbound" | "always";
  dmSessionScope?: "per-user" | "per-room";
  streaming?: MatrixStreamingMode;
  previewToolProgressEnabled?: boolean;
  blockStreamingEnabled?: boolean;
  dmEnabled?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  mediaMaxBytes?: number;
  startupMs?: number;
  startupGraceMs?: number;
  dropPreStartupMessages?: boolean;
  needsRoomAliasesForConfig?: boolean;
  isDirectMessage?: boolean;
  historyLimit?: number;
  readAllowFromStore?: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["readAllowFromStore"];
  upsertPairingRequest?: MatrixMonitorHandlerParams["core"]["channel"]["pairing"]["upsertPairingRequest"];
  buildPairingReply?: () => string;
  shouldHandleTextCommands?: () => boolean;
  hasControlCommand?: MatrixMonitorHandlerParams["core"]["channel"]["text"]["hasControlCommand"];
  resolveMarkdownTableMode?: () => string;
  resolveAgentRoute?: () => typeof DEFAULT_ROUTE;
  onRecorded?: (turn: MatrixRecordedTurn) => void;
  onResolvedTurn?: (turn: MatrixTurn) => void;
  onFinalized?: () => void;
  formatAgentEnvelope?: ({ body }: { body: string }) => string;
  finalizeInboundContext?: (ctx: unknown) => unknown;
  resolveHumanDelayConfig?: () => undefined;
  dispatchReplyFromConfig?: MatrixReplyScript;
  runChannelInboundEvent?: MatrixMonitorHandlerParams["core"]["channel"]["inbound"]["run"];
  inboundDeduper?: MatrixMonitorHandlerParams["inboundDeduper"];
  shouldAckReaction?: MatrixMonitorHandlerParams["core"]["channel"]["reactions"]["shouldAckReaction"];
  getRoomInfo?: MatrixMonitorHandlerParams["getRoomInfo"];
  getMemberDisplayName?: MatrixMonitorHandlerParams["getMemberDisplayName"];
  resolveLiveUserAllowlist?: MatrixMonitorHandlerParams["resolveLiveUserAllowlist"];
};

export function createMatrixHandlerTestHarness(options: MatrixHandlerTestHarnessOptions = {}) {
  const readAllowFromStore = options.readAllowFromStore ?? vi.fn(async () => [] as string[]);
  const upsertPairingRequest =
    options.upsertPairingRequest ?? vi.fn(async () => ({ code: "ABCDEFGH", created: false }));
  const resolveAgentRoute = options.resolveAgentRoute ?? vi.fn(() => DEFAULT_ROUTE);
  const owner = currentCase();
  owner.signal.throwIfAborted();
  const recordedTurn = vi.fn<(turn: MatrixRecordedTurn) => void>(options.onRecorded);
  const resolvedTurn = vi.fn<(turn: MatrixTurn) => void>(options.onResolvedTurn);
  const finalized = vi.fn(options.onFinalized);
  const deliveryObservations: MatrixDeliveryObservation[] = [];
  const finalizeInboundContext =
    options.finalizeInboundContext ??
    vi.fn((ctx: unknown) =>
      ctx && typeof ctx === "object"
        ? finalizeCoreInboundContext(ctx as Record<string, unknown>)
        : ctx,
    );
  const dispatchReplyFromConfig: MatrixReplyScript =
    options.dispatchReplyFromConfig ??
    (async () => ({ queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } }));
  const createChannelInboundEnvelopeBuilder = (() => (input: { body: string }) =>
    (options.formatAgentEnvelope ?? (({ body }: { body: string }) => body))({
      body: input.body,
    })) as NonNullable<MatrixMonitorHandlerParams["createChannelInboundEnvelopeBuilder"]>;
  const run: MatrixMonitorHandlerParams["core"]["channel"]["inbound"]["run"] = (params) => {
    // The runner owns the outer log hook; overlapping invocations need separate turn context.
    let resolvedForRecord: MatrixTurn | undefined;
    return (options.runChannelInboundEvent ?? runChannelInboundEvent)({
      ...params,
      log(event) {
        params.log?.(event);
        if (event.stage === "record" && event.event === "done") {
          const turn = resolvedForRecord;
          if (!turn) {
            throw new Error(
              "expected the Matrix recording event after resolving its delivery plan",
            );
          }
          recordedTurn({
            ctx: turn.ctxPayload,
            sessionKey: event.sessionKey,
            storePath: resolveStorePath(turn.cfg.session?.store, {
              agentId: turn.route.agentId,
            }),
            updateLastRoute: turn.record?.updateLastRoute,
          });
        }
      },
      adapter: {
        ...params.adapter,
        resolveTurn: async (...args) => {
          const resolved = await params.adapter.resolveTurn(...args);
          if (!("delivery" in resolved)) {
            throw new Error("expected the Matrix adapter's delivery plan");
          }
          const turn = resolved as MatrixTurn;
          resolvedTurn(turn);
          resolvedForRecord = turn;
          return {
            ...turn,
            ...(!options.runChannelInboundEvent || options.dispatchReplyFromConfig
              ? { dispatchReplyFromConfig }
              : {}),
            replyOptions: {
              ...turn.replyOptions,
              abortSignal: turn.replyOptions?.abortSignal ?? owner.signal,
            },
            record: {
              ...turn.record,
              trackSessionMetaTask(task) {
                owner.metadata.add(task);
                turn.record?.trackSessionMetaTask?.(task);
              },
              onRecordError(error) {
                owner.metadataErrors.push(error);
                turn.record?.onRecordError?.(error);
              },
            },
            delivery: {
              ...turn.delivery,
              async deliver(...deliveryArgs) {
                try {
                  const value = await turn.delivery.deliver(...deliveryArgs);
                  deliveryObservations.push({ kind: "delivered", value });
                  return value;
                } catch (error) {
                  deliveryObservations.push({ kind: "failed", error });
                  throw error;
                }
              },
            },
          };
        },
        onFinalize: async (...args) => {
          await params.adapter.onFinalize?.(...args);
          finalized();
        },
      },
    });
  };
  const dmPolicy = options.dmPolicy ?? "open";
  const allowFrom = options.allowFrom ?? (dmPolicy === "open" ? ["*"] : []);
  const cfgForHandler = matrixCaseConfig(
    options.cfg ??
      ({
        channels: {
          matrix: {
            dm: {
              allowFrom,
            },
          },
        },
      } as const),
  );

  const handle = createMatrixRoomMessageHandler({
    client: {
      getUserId: async () => "@bot:example.org",
      getEvent: async () => ({ sender: "@bot:example.org" }),
      ...options.client,
    } as never,
    core: {
      system: options.system ?? { enqueueSystemEvent },
      config: {
        current: () =>
          matrixCaseConfig(options.currentConfig?.() ?? options.liveCfg ?? cfgForHandler),
      },
      channel: {
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
          buildPairingReply: options.buildPairingReply ?? (() => "pairing"),
        },
        commands: {
          shouldHandleTextCommands: options.shouldHandleTextCommands ?? (() => false),
        },
        text: {
          hasControlCommand: options.hasControlCommand ?? (() => false),
          resolveMarkdownTableMode: options.resolveMarkdownTableMode ?? (() => "preserve"),
        },
        routing: {
          resolveAgentRoute,
        },
        mentions: {
          buildMentionRegexes: () => options.mentionRegexes ?? [],
        },
        reply: {
          settleReplyDispatcher,
        },
        inbound: {
          buildContext: buildChannelInboundEventContext,
          run,
        },
        reactions: {
          shouldAckReaction: options.shouldAckReaction ?? (() => false),
        },
      },
    } as never,
    cfg: cfgForHandler as never,
    accountId: options.accountId ?? "ops",
    accountConfig: options.accountConfig,
    runtime:
      options.runtime ??
      ({
        error: () => {},
      } as RuntimeEnv),
    logger:
      options.logger ??
      ({
        info: () => {},
        warn: () => {},
        error: () => {},
      } as RuntimeLogger),
    logVerboseMessage: options.logVerboseMessage ?? (() => {}),
    allowFrom,
    allowFromResolvedEntries: options.allowFromResolvedEntries,
    groupAllowFrom: options.groupAllowFrom ?? [],
    groupAllowFromResolvedEntries: options.groupAllowFromResolvedEntries,
    roomsConfig: options.roomsConfig,
    accountAllowBots: options.accountAllowBots,
    configuredBotUserIds: options.configuredBotUserIds,
    groupPolicy: options.groupPolicy ?? "open",
    replyToMode: options.replyToMode ?? "off",
    threadReplies: options.threadReplies ?? "inbound",
    dmThreadReplies: options.dmThreadReplies,
    dmSessionScope: options.dmSessionScope,
    streaming: options.streaming ?? "off",
    previewToolProgressEnabled: options.previewToolProgressEnabled ?? false,
    blockStreamingEnabled: options.blockStreamingEnabled ?? false,
    dmEnabled: options.dmEnabled ?? true,
    dmPolicy,
    mediaMaxBytes: options.mediaMaxBytes ?? 10_000_000,
    startupMs: options.startupMs ?? 0,
    startupGraceMs: options.startupGraceMs ?? 0,
    dropPreStartupMessages: options.dropPreStartupMessages ?? true,
    inboundDeduper: options.inboundDeduper,
    directTracker: {
      isDirectMessage: async () => options.isDirectMessage ?? true,
    },
    getRoomInfo: options.getRoomInfo ?? (async () => ({ altAliases: [] })),
    getMemberDisplayName: options.getMemberDisplayName ?? (async () => "sender"),
    needsRoomAliasesForConfig: options.needsRoomAliasesForConfig ?? false,
    resolveLiveUserAllowlist: options.resolveLiveUserAllowlist,
    resolveStorePath,
    createChannelInboundEnvelopeBuilder,
    finalizeInboundContext,
    resolveHumanDelayConfig: options.resolveHumanDelayConfig ?? (() => undefined),
    historyLimit: options.historyLimit ?? 0,
  });

  const handler: typeof handle = (...args) => owner.lifetime.track(handle(...args));
  return {
    dispatchReplyFromConfig,
    deliveryObservations,
    finalized,
    finalizeInboundContext,
    handler,
    readAllowFromStore,
    recordedTurn,
    resolvedTurn,
    resolveAgentRoute,
    upsertPairingRequest,
  };
}

export function createMatrixTextMessageEvent(params: {
  eventId: string;
  sender?: string;
  body: string;
  originServerTs?: number;
  relatesTo?: RoomMessageEventContent["m.relates_to"];
  mentions?: RoomMessageEventContent["m.mentions"];
  unsigned?: MatrixRawEvent["unsigned"];
}): MatrixRawEvent {
  return createMatrixRoomMessageEvent({
    eventId: params.eventId,
    sender: params.sender,
    originServerTs: params.originServerTs,
    unsigned: params.unsigned,
    content: {
      msgtype: "m.text",
      body: params.body,
      ...(params.relatesTo ? { "m.relates_to": params.relatesTo } : {}),
      ...(params.mentions ? { "m.mentions": params.mentions } : {}),
    },
  });
}

export function createMatrixRoomMessageEvent(params: {
  eventId: string;
  sender?: string;
  originServerTs?: number;
  unsigned?: MatrixRawEvent["unsigned"];
  content: RoomMessageEventContent;
}): MatrixRawEvent {
  return {
    type: EventType.RoomMessage,
    sender: params.sender ?? "@user:example.org",
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    content: params.content,
    ...(params.unsigned ? { unsigned: params.unsigned } : {}),
  } as MatrixRawEvent;
}

export function createMatrixReactionEvent(params: {
  eventId: string;
  targetEventId: string;
  key: string;
  sender?: string;
  originServerTs?: number;
}): MatrixRawEvent {
  return {
    type: EventType.Reaction,
    sender: params.sender ?? "@user:example.org",
    event_id: params.eventId,
    origin_server_ts: params.originServerTs ?? Date.now(),
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: params.targetEventId,
        key: params.key,
      },
    },
  } as MatrixRawEvent;
}
