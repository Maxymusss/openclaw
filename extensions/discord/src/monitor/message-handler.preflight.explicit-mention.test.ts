import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { describe, expect, it } from "vitest";
import { MessageType, type Message } from "../internal/discord.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordConfig,
} from "./message-handler.preflight.test-helpers.js";

async function runGuildPreflight(params: {
  channelId: string;
  guildId: string;
  message: Message;
  discordConfig: DiscordConfig;
  guildEntries?: Parameters<typeof preflightDiscordMessage>[0]["guildEntries"];
}) {
  return preflightDiscordMessage({
    ...createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: params.discordConfig,
      data: createGuildEvent({
        channelId: params.channelId,
        guildId: params.guildId,
        author: params.message.author,
        message: params.message,
      }),
      client: createGuildTextClient(params.channelId),
    }),
    guildEntries: params.guildEntries,
  });
}

describe("preflightDiscordMessage", () => {
  describe('requireMention="explicit"', () => {
    const guildId = "guild-explicit";
    const channelId = "channel-explicit";
    const author = { id: "sender-explicit", bot: false, username: "Sender" };
    const botTag = "<@openclaw-bot>";

    async function admit(params: {
      content: string;
      mentionedUsers?: Array<{ id: string }>;
      mentionedEveryone?: boolean;
      referencedMessage?: import("../internal/discord.js").Message;
      type?: MessageType;
      policy?: boolean | "explicit";
      channelPolicy?: boolean | "explicit";
    }) {
      return runGuildPreflight({
        channelId,
        guildId,
        discordConfig: {} as DiscordConfig,
        guildEntries: {
          [guildId]: {
            requireMention: params.policy ?? "explicit",
            ...(params.channelPolicy === undefined
              ? {}
              : { channels: { [channelId]: { requireMention: params.channelPolicy } } }),
          },
        },
        message: createDiscordMessage({
          id: "explicit-inbound",
          channelId,
          content: params.content,
          author,
          mentionedUsers: params.mentionedUsers,
          mentionedEveryone: params.mentionedEveryone,
          referencedMessage: params.referencedMessage,
          type: params.type,
        }),
      });
    }

    it.each([
      ["plain text", "hello", undefined, false],
      ["reply ping metadata", "hello", [{ id: "openclaw-bot" }], false],
      ["broadcast mention", "@everyone hello", undefined, true],
      ["escaped tag", String.raw`\<@openclaw-bot> hello`, [{ id: "openclaw-bot" }], false],
      ["inline code", "`<@openclaw-bot>`", [{ id: "openclaw-bot" }], false],
      ["fenced code", "```<@openclaw-bot>```", [{ id: "openclaw-bot" }], false],
    ] as const)("rejects %s without a typed bot tag", async (_label, content, users, everyone) => {
      expect(
        await admit({
          content,
          mentionedUsers: users ? [...users] : undefined,
          mentionedEveryone: everyone,
        }),
      ).toBeNull();
    });

    it("rejects an untagged reply to the bot and an untagged text command", async () => {
      const referencedMessage = createDiscordMessage({
        id: "bot-message",
        channelId,
        content: "hello",
        author: { id: "openclaw-bot", bot: true },
      });
      expect(await admit({ content: "reply", referencedMessage })).toBeNull();
      expect(await admit({ content: "/status" })).toBeNull();
    });

    it("admits raw user tags even if Discord omitted mention metadata", async () => {
      expect(await admit({ content: `hello ` + botTag })).not.toBeNull();
      expect(await admit({ content: "<@!openclaw-bot> hello" })).not.toBeNull();
    });

    it("preserves boolean policy and exact channel override precedence", async () => {
      expect(await admit({ content: "plain", policy: false })).not.toBeNull();
      expect(await admit({ content: "plain", channelPolicy: false })).not.toBeNull();
      expect(
        await admit({ content: "plain", policy: false, channelPolicy: "explicit" }),
      ).toBeNull();
      expect(await admit({ content: "plain", policy: "explicit", channelPolicy: true })).toBeNull();
      expect(
        await admit({ content: botTag, policy: false, channelPolicy: "explicit" }),
      ).not.toBeNull();
    });

    it("inherits the explicit parent channel rule in threads", async () => {
      const threadId = "thread-explicit";
      const parentId = "parent-explicit";
      const run = (content: string) => {
        const message = createDiscordMessage({
          id: "thread-inbound",
          channelId: threadId,
          content,
          author,
        });
        return preflightDiscordMessage({
          ...createDiscordPreflightArgs({
            cfg: DEFAULT_PREFLIGHT_CFG,
            discordConfig: {} as DiscordConfig,
            data: createGuildEvent({
              channelId: threadId,
              guildId,
              author: message.author,
              message,
            }),
            client: createThreadClient({ threadId, parentId }),
          }),
          guildEntries: {
            [guildId]: {
              channels: { [parentId]: { requireMention: "explicit", autoThread: true } },
            },
          },
        });
      };
      expect(await run("plain thread text")).toBeNull();
      expect(await run(`hello ` + botTag)).not.toBeNull();
    });
  });
});
