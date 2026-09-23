import {
  toHistoryMediaEntries,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { resolveTimestampMs } from "./format.js";
import { resolveDiscordMessageStickers } from "./message-forwarded.js";
import {
  createDiscordHistorySenderProvenance,
  resolveDiscordHistoryMediaIds,
  type DiscordHistoryEntry,
} from "./message-handler.history.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import { resolveMediaList } from "./message-media.js";
import { resolveDiscordMessageHistoryText } from "./message-text.js";
import type { DiscordSenderIdentity } from "./sender-identity.js";

export function buildDiscordPreflightHistoryEntry(params: {
  isGuildMessage: boolean;
  historyLimit: number;
  message: DiscordMessagePreflightContext["message"];
  senderLabel: string;
  sender: Pick<DiscordSenderIdentity, "id" | "name" | "tag">;
  memberRoleIds: readonly string[];
}): DiscordHistoryEntry | undefined {
  const textForHistory = resolveDiscordMessageHistoryText(params.message, {
    includeForwarded: true,
  });
  return params.isGuildMessage && params.historyLimit > 0 && textForHistory
    ? {
        sender: params.senderLabel,
        body: textForHistory,
        timestamp: resolveTimestampMs(params.message.timestamp),
        messageId: params.message.id,
        mediaIds: resolveDiscordHistoryMediaIds(params.message),
        senderProvenance: createDiscordHistorySenderProvenance({
          sender: params.sender,
          memberRoleIds: params.memberRoleIds,
        }),
      }
    : undefined;
}

const DISCORD_HISTORY_MEDIA_MAX_ATTACHMENTS = 4;
const DISCORD_HISTORY_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const DISCORD_HISTORY_MEDIA_IDLE_TIMEOUT_MS = 1_000;
const DISCORD_HISTORY_MEDIA_TOTAL_TIMEOUT_MS = 3_000;

function isDiscordImageAttachmentCandidate(attachment: {
  content_type?: string | null;
  filename?: string | null;
  url?: string | null;
}) {
  const contentType = attachment.content_type?.split(";")[0]?.trim().toLowerCase();
  if (contentType?.startsWith("image/")) {
    return true;
  }
  return Boolean(
    mimeTypeFromFilePath(attachment.filename)?.startsWith("image/") ||
    mimeTypeFromFilePath(attachment.url)?.startsWith("image/"),
  );
}

async function resolveDiscordHistoryMediaForPendingRecord(params: {
  preflight: DiscordMessagePreflightParams;
  message: DiscordMessagePreflightContext["message"];
}) {
  const imageAttachments = (params.message.attachments ?? [])
    .filter(isDiscordImageAttachmentCandidate)
    .slice(0, DISCORD_HISTORY_MEDIA_MAX_ATTACHMENTS);
  const stickers = resolveDiscordMessageStickers(params.message).slice(
    0,
    Math.max(0, DISCORD_HISTORY_MEDIA_MAX_ATTACHMENTS - imageAttachments.length),
  );
  if (imageAttachments.length === 0 && stickers.length === 0) {
    return [];
  }
  const rawData = (() => {
    try {
      return params.message.rawData;
    } catch {
      return {};
    }
  })();
  const mediaMessage = Object.assign(
    Object.create(Object.getPrototypeOf(params.message)),
    params.message,
    // SAFETY: Clone retains the Message prototype and fields; only media fields are overridden below.
  ) as typeof params.message;
  Object.defineProperties(mediaMessage, {
    attachments: { value: imageAttachments },
    rawData: {
      value: {
        ...rawData,
        attachments: imageAttachments,
        sticker_items: stickers,
        stickers,
      },
    },
    stickers: { value: stickers },
  });
  const mediaList = await resolveMediaList(
    mediaMessage,
    Math.min(params.preflight.mediaMaxBytes, DISCORD_HISTORY_MEDIA_MAX_BYTES),
    {
      fetchImpl: params.preflight.discordRestFetch,
      ssrfPolicy: params.preflight.cfg.browser?.ssrfPolicy,
      readIdleTimeoutMs: DISCORD_HISTORY_MEDIA_IDLE_TIMEOUT_MS,
      totalTimeoutMs: DISCORD_HISTORY_MEDIA_TOTAL_TIMEOUT_MS,
      abortSignal: params.preflight.abortSignal,
    },
  );
  const stickerStartIndex = Math.max(0, mediaList.length - stickers.length);
  return (await toInboundMediaFactsWithMetadata(mediaList, { messageId: params.message.id })).map(
    (media, index) => ({
      path: media.path,
      url: media.url,
      contentType: media.contentType,
      kind: index >= stickerStartIndex ? "sticker" : (media.kind ?? "image"),
      durationMs: media.durationMs,
      width: media.width,
      height: media.height,
      transcribed: media.transcribed,
      messageId: media.messageId,
    }),
  );
}

export async function recordDiscordPendingHistoryEntry(params: {
  preflight: DiscordMessagePreflightParams;
  historyKey: string;
  message: DiscordMessagePreflightContext["message"];
  entry?: DiscordHistoryEntry;
}) {
  if (!params.entry || params.preflight.historyLimit <= 0) {
    return;
  }
  await createChannelHistoryWindow<DiscordHistoryEntry>({
    historyMap: params.preflight.guildHistories,
  }).recordWithMedia({
    historyKey: params.historyKey,
    entry: params.entry,
    limit: params.preflight.historyLimit,
    mediaLimit: DISCORD_HISTORY_MEDIA_MAX_ATTACHMENTS,
    messageId: params.message.id,
    shouldRecord: () =>
      !params.preflight.abortSignal?.aborted && params.preflight.isPolicyCurrent?.() !== false,
    media: async () =>
      toHistoryMediaEntries(
        await resolveDiscordHistoryMediaForPendingRecord({
          preflight: params.preflight,
          message: params.message,
        }),
        { messageId: params.message.id },
      ),
  });
}
