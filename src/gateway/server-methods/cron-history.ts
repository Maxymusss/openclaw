import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  CronHistoryParamsSchema,
  CronHistoryResultSchema,
} from "../../../packages/gateway-protocol/src/schema/cron.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveTranscriptSessionKeyBySessionId } from "../../config/sessions/session-accessor.js";
import { cronRunRecordToRunLogEntry } from "../../cron/run-history-detail.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { readCronRunRecords } from "../../cron/store/read-only.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const MAX_CRON_HISTORY_BYTES = 4 * 1024 * 1024;

export async function handleCronHistoryRequest(
  opts: GatewayRequestHandlerOptions,
  assertAllowed: (sessionKey?: string, agentId?: string) => void,
): Promise<void> {
  const { params, respond, context } = opts;
  if (
    !Value.Check(CronHistoryParamsSchema, params) ||
    (!params.runId && params.runAtMs === undefined)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "cron.history requires an id and exact runId or runAtMs",
      ),
    );
    return;
  }
  const fail = () =>
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The recorded cron transcript is unavailable. Refresh the run and try again.",
      ),
    );
  const storeKey = cronStoreKey(context.cronStorePath);
  try {
    assertAllowed();
    const select = async () =>
      (await readCronRunRecords(storeKey, params.id)).flatMap((record) => {
        const entry = cronRunRecordToRunLogEntry(record);
        return entry &&
          (!params.runId || entry.runId === params.runId) &&
          (params.runAtMs === undefined || entry.runAtMs === params.runAtMs)
          ? [{ record, entry }]
          : [];
      });
    const matches = await select();
    if (matches.length !== 1) {
      fail();
      return;
    }
    const selected = matches[0]!;
    const { sessionKey, sessionId } = selected.entry;
    if (!sessionKey || !sessionId) {
      fail();
      return;
    }
    const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? selected.record.agentId;
    const bindingFor = (value: typeof selected) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            storeKey,
            value.record.id,
            value.record.runId,
            value.entry.jobId,
            value.entry.runId,
            value.entry.runAtMs,
            value.entry.sessionKey,
            value.entry.sessionId,
            value.record.agentId,
          ]),
        )
        .digest("base64url");
    const binding = bindingFor(selected);
    let offset = 0;
    if (params.cursor) {
      const cursor: unknown = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8"));
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        cursor[0] !== binding ||
        !Number.isSafeInteger(cursor[1]) ||
        cursor[1] < 0
      ) {
        throw new Error("Invalid cron history cursor");
      }
      offset = cursor[1];
    }
    const scope = {
      agentId,
      sessionId,
      storePath: resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, {
        agentId,
      }),
    };
    const ownerKey = resolveTranscriptSessionKeyBySessionId(scope);
    const { baseSessionKey } = parseCronRunScopeSuffix(sessionKey);
    if (!ownerKey || (ownerKey !== sessionKey && ownerKey !== baseSessionKey)) {
      fail();
      return;
    }
    const assertCurrent = () => {
      if (
        opts.signal?.aborted ||
        opts.hasCurrentClientAuthority?.() === false ||
        cronStoreKey(context.cronStorePath) !== storeKey ||
        resolveSessionStorePathCore(context.getRuntimeConfig().session?.store, { agentId }) !==
          scope.storePath ||
        resolveTranscriptSessionKeyBySessionId(scope) !== ownerKey
      ) {
        throw new Error("Cron history access changed");
      }
      assertAllowed(sessionKey, agentId);
    };
    const { handleChatHistoryRequest } = await import("./chat-history-handler.js");
    assertCurrent();
    let reply: Parameters<GatewayRequestHandlerOptions["respond"]> | undefined;
    await handleChatHistoryRequest({
      ...opts,
      method: "chat.history",
      retainedSessionId: sessionId,
      params: {
        sessionKey: ownerKey,
        ...(agentId ? { agentId } : {}),
        limit: params.limit ?? 100,
        offset,
        maxBytes: MAX_CRON_HISTORY_BYTES - 16_384,
      },
      respond: (...response) => {
        reply = response;
      },
    });
    // Retention/removal cannot turn a captured run into authority after an asynchronous transcript read.
    const current = await select();
    await context.cron.readJob(params.id);
    assertCurrent();
    if (current.length !== 1 || bindingFor(current[0]!) !== binding) {
      fail();
      return;
    }
    if (!reply) {
      fail();
      return;
    }
    if (!reply[0]) {
      respond(...reply);
      return;
    }
    const page = asOptionalRecord(reply[1]);
    const result = {
      messages: page?.messages,
      ...(page?.activity ? { activity: page.activity } : {}),
      ...(page?.hasMore === true && typeof page.nextOffset === "number"
        ? {
            nextCursor: Buffer.from(JSON.stringify([binding, page.nextOffset])).toString(
              "base64url",
            ),
          }
        : {}),
    };
    if (
      !Value.Check(CronHistoryResultSchema, result) ||
      Buffer.byteLength(JSON.stringify(result)) > MAX_CRON_HISTORY_BYTES
    ) {
      throw new Error("Invalid cron transcript page");
    }
    respond(true, result);
  } catch {
    fail();
  }
}
