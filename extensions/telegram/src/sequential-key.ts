import type { Message, UserFromGetMe } from "grammy/types";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { isStandaloneModelCommand } from "openclaw/plugin-sdk/command-surface";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasTelegramApprovalCallbackPrefix } from "./approval-callback-data.js";
import {
  getCachedTelegramForumFlag,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMessageForumFlagHint,
  resolveTelegramMessageThreadSpec,
  resolveTelegramPrimaryMedia,
  shouldUseTelegramDmThreadSession,
} from "./bot/helpers.js";
import { getPreparedTelegramPollAnswer } from "./poll-answer-context.js";
import type { TelegramPollRegistryEntry } from "./poll-registry.js";
import { hasTelegramQuestionCallbackPrefix } from "./question-callback-data.js";

const TELEGRAM_READ_ONLY_COMMAND_KEYS = new Set([
  "agents",
  "commands",
  "context",
  "help",
  "models",
  "status",
  "subagents",
  "tasks",
  "tools",
  "whoami",
]);

// Control-lane admission is an inspection/interrupt privilege, not a restatement of
// `activeRunSafe`. `activeRunSafe` only says a command may execute while a turn is
// active; it also covers session-mutating commands (`/new`, `/reset`, `/think`) whose
// writes must stay ordered behind their own topic's pending input. `/approve` belongs
// here because the run that requested the approval is holding its own lane.
const TELEGRAM_ACTIVE_RUN_CONTROL_COMMAND_KEYS = new Set(["approve", "queue", "steer"]);
const ordinaryModelAliasContexts = new WeakSet<object>();

type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedMessage?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { message?: Message; data?: string };
    message_reaction?: {
      chat?: { id?: number; type?: string; is_forum?: boolean; is_direct_messages?: boolean };
      message_id?: number;
    };
    poll_answer?: { poll_id?: string };
  };
};

type TelegramSequentialKeyOptions = {
  modelAliasOrdinary?: boolean;
};

export function resolveTelegramSequentialMessage(
  ctx: TelegramSequentialKeyContext,
): Message | undefined {
  return (
    ctx.message ??
    ctx.channelPost ??
    ctx.editedMessage ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message
  );
}

function getTelegramMessageReactionSequentialKey(
  ctx: TelegramSequentialKeyContext,
): string | undefined {
  const reaction = ctx.update?.message_reaction;
  if (
    (reaction?.chat?.is_forum === true || reaction?.chat?.is_direct_messages === true) &&
    typeof reaction.chat.id === "number" &&
    typeof reaction.message_id === "number"
  ) {
    return `telegram:${reaction.chat.id}:message:${reaction.message_id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedMessage ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post;
  const isForum = resolveTelegramMessageForumFlagHint({
    chatType: msg?.chat?.type,
    isForum: msg?.chat?.is_forum,
    isTopicMessage: msg?.is_topic_message,
  });
  const isScopedMessage = isForum || msg?.chat.is_direct_messages === true;
  return isScopedMessage && typeof msg?.chat.id === "number" && typeof msg.message_id === "number"
    ? `telegram:${msg.chat.id}:message:${msg.message_id}`
    : undefined;
}

/** Registry key for a text command, or undefined when the text is not one. */
function resolveTelegramCommandKeyForControlLane(params: {
  rawText?: string;
  botUsername?: string;
}): string | undefined {
  const trimmed = params.rawText?.trim();
  if (!trimmed) {
    return undefined;
  }
  const alias = maybeResolveTextAlias(
    normalizeCommandBody(
      trimmed,
      params.botUsername ? { botUsername: params.botUsername } : undefined,
    ),
  );
  if (!alias) {
    return undefined;
  }
  return listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  )?.key;
}

export function isTelegramReadOnlyControlLaneText(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  // Read-only commands must not supersede pending work when they enter the control lane.
  // Diagnostics and export commands materialize state and remain on the ordinary lane.
  const key = resolveTelegramCommandKeyForControlLane(params);
  return key !== undefined && TELEGRAM_READ_ONLY_COMMAND_KEYS.has(key);
}

function isTelegramActiveRunControlLaneText(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  const key = resolveTelegramCommandKeyForControlLane(params);
  return key !== undefined && TELEGRAM_ACTIVE_RUN_CONTROL_COMMAND_KEYS.has(key);
}

function isTelegramModelSelectionText(params: {
  rawText?: string;
  botUsername?: string;
  cfg?: OpenClawConfig;
}): boolean {
  return isStandaloneModelCommand(
    normalizeCommandBody(params.rawText ?? "", {
      botUsername: params.botUsername,
      preserveArguments: true,
    }),
    params.cfg ?? {},
  );
}

export function resolveTelegramConfiguredModelAlias(params: {
  rawText?: string;
  botUsername?: string;
  cfg?: OpenClawConfig;
}): { commandBody: string; commandName: string } | undefined {
  if (!params.cfg) {
    return undefined;
  }
  const commandBody = normalizeCommandBody(params.rawText ?? "", {
    botUsername: params.botUsername,
    preserveArguments: true,
  });
  if (
    !isStandaloneModelCommand(commandBody, params.cfg) ||
    resolveTelegramCommandKeyForControlLane({ rawText: commandBody }) !== undefined
  ) {
    return undefined;
  }
  const commandName = commandBody.match(/^\/([^\s:]+)/u)?.[1]?.toLowerCase();
  return commandName ? { commandBody, commandName } : undefined;
}

export function markTelegramModelAliasOrdinary(ctx: object): void {
  ordinaryModelAliasContexts.add(ctx);
}

export function isTelegramModelAliasOrdinary(ctx: object): boolean {
  return ordinaryModelAliasContexts.has(ctx);
}

export function isTelegramControlLaneText(params: {
  cfg?: OpenClawConfig;
  rawText?: string;
  botUsername?: string;
}): boolean {
  // Live polling and webhook admission already have bot identity. In defensive pre-identity
  // paths, accepting every @target admits foreign-bot commands; only canonical aborts fence.
  const abortCommandOptions = params.botUsername
    ? { botUsername: params.botUsername }
    : { targetedCommandMode: "pre-identity" as const };
  if (isAbortRequestText(params.rawText, abortCommandOptions)) {
    return true;
  }
  if (isTelegramModelSelectionText(params)) {
    return true;
  }
  if (isTelegramActiveRunControlLaneText(params)) {
    return true;
  }
  return isTelegramReadOnlyControlLaneText(params);
}

export function getTelegramSequentialKey(
  ctx: TelegramSequentialKeyContext,
  cfg?: OpenClawConfig,
  options?: TelegramSequentialKeyOptions,
): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const update = ctx.update;
  const pollId = update?.poll_answer?.poll_id;
  if (pollId) {
    const prepared = getPreparedTelegramPollAnswer(update);
    const entry = prepared?.entry;
    if (entry) {
      return getTelegramPollAnswerSequentialKey(entry);
    }
    // Missing historical registry entries do no work, but keep duplicate answers
    // for the same unknown poll together while the handler records the miss.
    return `telegram:poll:${pollId}`;
  }
  const msg = resolveTelegramSequentialMessage(ctx);
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  const modelAliasOrdinary =
    options?.modelAliasOrdinary === true || isTelegramModelAliasOrdinary(ctx);
  const modelSelectionWithMedia =
    resolveTelegramPrimaryMedia(msg) !== undefined &&
    isTelegramModelSelectionText({ rawText, botUsername, cfg });
  const modelSelectionOrdinary = modelAliasOrdinary || modelSelectionWithMedia;
  // Alias resolution can discover an executable skill and wait for ordinary
  // admission. Keep that wait out of the inspection/interrupt lane.
  if (!modelSelectionOrdinary && isTelegramModelSelectionText({ rawText, botUsername, cfg })) {
    return typeof chatId === "number" ? `telegram:${chatId}:model` : "telegram:model";
  }
  if (!modelSelectionOrdinary && isTelegramControlLaneText({ rawText, botUsername, cfg })) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (isBtwRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    const messageId = msg?.message_id;
    if (typeof chatId === "number" && typeof messageId === "number") {
      return `telegram:${chatId}:btw:${messageId}`;
    }
    if (typeof chatId === "number") {
      return `telegram:${chatId}:btw`;
    }
    return "telegram:btw";
  }
  const callbackData = ctx.update?.callback_query?.data;
  if (hasTelegramQuestionCallbackPrefix(callbackData)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:question`;
    }
    return "telegram:question";
  }
  if (
    hasTelegramApprovalCallbackPrefix(callbackData) ||
    (callbackData && parseExecApprovalCommandText(callbackData) !== null)
  ) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:approval`;
    }
    return "telegram:approval";
  }
  // Raw durable-ingress fixtures and malformed updates can carry a partial
  // message. Treat missing chat identity as an unknown lane instead of
  // crashing before the queue records the update.
  //
  // General forum topic (topic:1) messages lack both `is_topic_message` and
  // `is_forum` in the payload, so the forum flag hint is undefined. Fall back
  // to the in-memory cache (populated by earlier messages or getChat calls)
  // so the lane key resolves to `telegram:${chatId}:topic:1` rather than the
  // base lane, preventing a cross-lane session-init race.
  const forumHint = msg?.chat
    ? resolveTelegramMessageForumFlagHint({
        chatType: msg.chat.type,
        isForum: msg.chat.is_forum,
        isTopicMessage: msg.is_topic_message,
      })
    : undefined;
  const cachedForumFlag =
    forumHint === undefined && msg?.chat?.type === "supergroup" && typeof msg.chat.id === "number"
      ? getCachedTelegramForumFlag(msg.chat.id)
      : undefined;
  const threadSpec = msg?.chat
    ? resolveTelegramMessageThreadSpec(msg, forumHint ?? cachedForumFlag)
    : undefined;
  const threadId =
    threadSpec?.scope === "dm"
      ? shouldUseTelegramDmThreadSession({
          dmThreadId: threadSpec.id,
          botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
        })
        ? threadSpec.id
        : undefined
      : threadSpec?.id;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}

function getTelegramPollAnswerSequentialKey(entry: TelegramPollRegistryEntry): string {
  const threadId = "id" in entry.threadSpec ? entry.threadSpec.id : undefined;
  return threadId == null
    ? `telegram:${entry.chat.id}`
    : `telegram:${entry.chat.id}:topic:${threadId}`;
}

export function getTelegramSequentialConstraints(
  ctx: TelegramSequentialKeyContext,
  cfg?: OpenClawConfig,
  options?: TelegramSequentialKeyOptions,
): string | string[] {
  const key = getTelegramSequentialKey(ctx, cfg, options);
  const messageKey = getTelegramMessageReactionSequentialKey(ctx);
  if (ctx.update?.message_reaction && messageKey) {
    return messageKey;
  }
  // Scoped reactions read the topic fact recorded by the message update they target.
  // Bridge that exact message without serializing unrelated topics.
  return messageKey ? [key, messageKey] : key;
}
