import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readTelegramPrivateProductionDescriptor,
  requestTelegramPrivateAppTurn,
  resolveTelegramPrivateProductionBot,
} from "./private-production.runtime.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const roots: string[] = [];

function writeDescriptor() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-private-apps-test-"));
  roots.push(root);
  const file = path.join(root, "descriptor.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      mode: "private-production-local-apps",
      forumGroupId: "-100456",
      forumTopicId: 42,
      topicTitle: "Private proof",
      participants: [
        { alias: "primary", host: "mainframe", userId: "100" },
        { alias: "second", host: "macbook", userId: "101" },
      ],
    }),
    { mode: 0o600 },
  );
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  fetchWithSsrFGuardMock.mockReset();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Telegram private production local-app proof", () => {
  it("parses two distinct operator-local participants without credential material", () => {
    const file = writeDescriptor();

    expect(readTelegramPrivateProductionDescriptor(file)).toEqual({
      file,
      mode: "private-production-local-apps",
      forumGroupId: "-100456",
      forumTopicId: 42,
      topicTitle: "Private proof",
      participants: [
        { alias: "primary", host: "mainframe", userId: "100" },
        { alias: "second", host: "macbook", userId: "101" },
      ],
    });
  });

  it("resolves the bot through the guarded network boundary and releases it", async () => {
    const release = vi.fn();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          ok: true,
          result: { id: 700000001, username: "qa_bot" },
        }),
        { status: 200 },
      ),
      release,
    });

    await expect(
      resolveTelegramPrivateProductionBot({ TELEGRAM_BOT_TOKEN: "test-token" }),
    ).resolves.toEqual({
      id: "700000001",
      token: "test-token",
      username: "qa_bot",
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://api.telegram.org/bottest-token/getMe",
      init: { method: "POST" },
      timeoutMs: 30_000,
      maxRedirects: 0,
      auditContext: "qa-lab-telegram-private-production-bot-api",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts a native UI acknowledgement without placing raw participant IDs in the handoff", async () => {
    const file = writeDescriptor();
    const descriptor = readTelegramPrivateProductionDescriptor(file)!;
    const requestReady = Promise.withResolvers<void>();
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (String(chunk).startsWith("TELEGRAM_PRIVATE_APP_SEND_REQUIRED ")) {
        requestReady.resolve();
      }
      return true;
    });
    const pending = requestTelegramPrivateAppTurn({
      descriptor,
      destination: "forum-topic",
      participant: descriptor.participants[1]!,
      text: "@qa_bot Reply exactly: marker",
    });
    const proofRoot = `${file}.app-proof`;
    await Promise.race([requestReady.promise, pending]);
    const requestPath = fs
      .readdirSync(proofRoot)
      .map((entry) => path.join(proofRoot, entry))
      .find((entry) => entry.endsWith(".request.json"));
    expect(requestPath).toBeDefined();
    const requestText = fs.readFileSync(requestPath!, "utf8");
    expect(requestText).not.toContain('"100"');
    expect(requestText).not.toContain('"101"');
    const request = JSON.parse(requestText) as {
      destination: string;
      text: string;
      token: string;
    };
    fs.writeFileSync(
      path.join(proofRoot, `${request.token}.ack.json`),
      JSON.stringify({
        schemaVersion: 1,
        token: request.token,
        sentText: request.text,
        replyText: "marker",
        replyObservedIn: request.destination,
        replyToRequestedMessage: true,
      }),
      { mode: 0o600 },
    );

    await expect(pending).resolves.toEqual({ replyText: "marker" });
    expect(fs.readdirSync(proofRoot)).toEqual([]);
  });
});
