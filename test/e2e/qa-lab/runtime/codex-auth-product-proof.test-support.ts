import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../../../../src/agents/auth-profiles/persisted.js";
import type { OpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

const OAUTH_PROFILE_ID = "openai:qa-oauth";
const LEGACY_OAUTH_PROFILE_ID = "openai-codex:qa-oauth";
const API_KEY_PROFILE_ID = "openai:media-api";

export type CodexAuthMigrationShape = "mixed" | "oauth-only";

export async function runCodexAuthDoctorMigrationProof(
  instance: OpenClawTestInstance,
  params: {
    accountId: string;
    oauthAccess: string;
    shape: CodexAuthMigrationShape;
  },
) {
  const includeApiKey = params.shape === "mixed";
  const expectedOrder = includeApiKey ? [OAUTH_PROFILE_ID, API_KEY_PROFILE_ID] : [OAUTH_PROFILE_ID];
  const profiles: Record<string, Record<string, unknown>> = {
    [LEGACY_OAUTH_PROFILE_ID]: {
      type: "oauth",
      provider: "openai-codex",
      access: params.oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: params.accountId,
    },
  };
  const order: Record<string, string[]> = {
    "openai-codex": [LEGACY_OAUTH_PROFILE_ID],
  };
  if (includeApiKey) {
    profiles[API_KEY_PROFILE_ID] = {
      type: "api_key",
      provider: "openai",
      key: "test-api-key",
    };
    order.openai = [API_KEY_PROFILE_ID];
  }

  const legacyAuthPath = await instance.state.writeText(
    "agents/main/agent/auth-profiles.json",
    `${JSON.stringify({ version: 1, profiles, order }, null, 2)}\n`,
  );
  const doctor = await instance.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
    timeoutMs: 120_000,
  });
  expect(doctor.code, doctor.stderr).toBe(0);

  const canonicalStore = loadPersistedSharedAuthProfileStore(instance.env);
  const expectedProfiles: Record<string, Record<string, unknown>> = {
    [OAUTH_PROFILE_ID]: {
      type: "oauth",
      provider: "openai",
      access: params.oauthAccess,
      refresh: "test-refresh",
      expires: Date.UTC(2036, 0, 1),
      accountId: params.accountId,
    },
  };
  if (includeApiKey) {
    expectedProfiles[API_KEY_PROFILE_ID] = { type: "api_key", provider: "openai" };
  }
  expect(canonicalStore).toMatchObject({
    profiles: expectedProfiles,
    order: { openai: expectedOrder },
  });
  expect(canonicalStore?.profiles[LEGACY_OAUTH_PROFILE_ID]).toBeUndefined();
  await expect(fs.access(legacyAuthPath)).rejects.toMatchObject({ code: "ENOENT" });
  return canonicalStore;
}

export type CodexFixtureTurnAccountEvidence = {
  instanceId: string;
  threadId: string;
  turnId: string;
  threadOperation: "thread_started" | "thread_resumed";
  threadSequence: number;
  startedSequence: number;
  completedSequence: number;
  account: { type: "chatgptAuthTokens"; accountId: string };
};

export function findCodexFixtureTurnAccountEvidence(
  entries: readonly unknown[],
  params: { afterIndex: number; threadId: string; accountId: string },
): CodexFixtureTurnAccountEvidence | undefined {
  if (
    !Number.isSafeInteger(params.afterIndex) ||
    params.afterIndex < 0 ||
    params.afterIndex > entries.length ||
    !params.threadId.trim() ||
    !params.accountId.trim()
  ) {
    return undefined;
  }
  const operations = entries.flatMap((entry, index) =>
    isRecord(entry) && isRecord(entry.fixtureAuthOperation)
      ? [{ index, value: entry.fixtureAuthOperation }]
      : [],
  );
  const turns = operations.filter(
    ({ index, value }) =>
      index >= params.afterIndex &&
      value.threadId === params.threadId &&
      (value.operation === "turn_started" || value.operation === "turn_completed"),
  );
  const started = turns[0];
  const completed = turns[1];
  if (turns.length !== 2 || !started || !completed) {
    return undefined;
  }
  if (
    started.value.operation !== "turn_started" ||
    completed.value.operation !== "turn_completed" ||
    started.value.version !== 1 ||
    completed.value.version !== 1 ||
    typeof started.value.instanceId !== "string" ||
    !started.value.instanceId.trim() ||
    completed.value.instanceId !== started.value.instanceId ||
    typeof started.value.turnId !== "string" ||
    !started.value.turnId.trim() ||
    completed.value.turnId !== started.value.turnId ||
    typeof started.value.sequence !== "number" ||
    !Number.isSafeInteger(started.value.sequence) ||
    started.value.sequence <= 0 ||
    typeof completed.value.sequence !== "number" ||
    !Number.isSafeInteger(completed.value.sequence) ||
    completed.value.sequence <= started.value.sequence ||
    !isRecord(started.value.account) ||
    started.value.account.type !== "chatgptAuthTokens" ||
    started.value.account.accountId !== params.accountId ||
    !isRecord(completed.value.account) ||
    completed.value.account.type !== "chatgptAuthTokens" ||
    completed.value.account.accountId !== params.accountId
  ) {
    return undefined;
  }
  // A warm thread can predate this control; only its new turn must follow the cursor.
  const thread = operations.findLast(
    ({ index, value }) =>
      index < started.index &&
      value.instanceId === started.value.instanceId &&
      value.threadId === params.threadId &&
      (value.operation === "thread_started" || value.operation === "thread_resumed"),
  )?.value;
  if (
    !thread ||
    thread.version !== 1 ||
    typeof thread.sequence !== "number" ||
    !Number.isSafeInteger(thread.sequence) ||
    thread.sequence <= 0 ||
    thread.sequence >= started.value.sequence
  ) {
    return undefined;
  }
  return {
    instanceId: started.value.instanceId,
    threadId: params.threadId,
    turnId: started.value.turnId,
    threadOperation: thread.operation as "thread_started" | "thread_resumed",
    threadSequence: thread.sequence,
    startedSequence: started.value.sequence,
    completedSequence: completed.value.sequence,
    account: { type: "chatgptAuthTokens", accountId: started.value.account.accountId },
  };
}

export async function captureCodexAuthFailure(params: {
  instance: OpenClawTestInstance;
  client: import("../../../../src/gateway/client.js").GatewayClient;
  events: readonly unknown[];
  terminal: unknown;
  error: unknown;
  sessionKey: string;
  runId: string;
  configuredProfileId: string;
  recoveryText: string;
  fixtureSecrets: readonly string[];
}) {
  try {
    const scalar = (value: unknown) =>
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
        ? value
        : null;
    const pick = (value: unknown, keys: readonly string[]) =>
      Object.fromEntries(
        keys.map((key) => [key, scalar(isRecord(value) ? value[key] : undefined)]),
      );
    const runFields = [
      "runId",
      "sessionKey",
      "key",
      "sessionId",
      "lifecycleRevision",
      "lastRunId",
      "state",
      "status",
      "lastRunError",
      "hasActiveRun",
      "seq",
      "ts",
      "messageId",
      "messageSeq",
      "stream",
      "errorMessage",
      "errorKind",
      "stopReason",
    ];
    const waitFields = [
      "runId",
      "status",
      "error",
      "startedAt",
      "endedAt",
      "stopReason",
      "livenessState",
      "yielded",
      "pendingError",
      "timeoutPhase",
      "providerStarted",
    ];
    const detailFields = [
      "provider",
      "model",
      "failoverReason",
      "providerRuntimeFailureKind",
      "providerErrorType",
      "httpStatus",
      "providerErrorMessagePreview",
    ];
    const textFacts = (value: unknown) =>
      typeof value === "string"
        ? {
            observed: true,
            length: value.length,
            containsFullRecoveryText: value.includes(params.recoveryText),
            containsRecoveryPrefix: value.includes("The selected auth profile is unavailable"),
            containsConfigureAction: value.includes("openclaw configure"),
            endsWithRetry: /then retry\.$/u.test(value),
          }
        : { observed: false };
    const messageFacts = (value: unknown) => {
      if (!isRecord(value)) {
        return { observed: false };
      }
      const textBlocks = Array.isArray(value.content)
        ? value.content.flatMap((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? [block.text]
              : [],
          )
        : [];
      const content =
        typeof value.content === "string"
          ? value.content
          : textBlocks.length > 0
            ? textBlocks.join("\n")
            : undefined;
      return {
        observed: true,
        ...pick(value, ["id", "role", "customType"]),
        openclawOwnership: pick(value.__openclaw, ["runId"]),
        customOwnership: pick(value.details, ["runId"]),
        text: textFacts(content),
      };
    };
    const activeRuns = (value: unknown) =>
      Array.isArray(value)
        ? {
            values: value.slice(0, 16).map(scalar),
            omitted: Math.max(0, value.length - 16),
          }
        : null;
    const observe = <T>(read: () => T) => {
      try {
        return { status: "observed" as const, value: read() };
      } catch {
        return { status: "unobserved" as const };
      }
    };
    // Own only scalar projections before any import/RPC; later diagnostics cannot rewrite chronology.
    const snapshotAt = Date.now();
    const chronology = observe(() => {
      const relevant = params.events.flatMap((event, index) =>
        isRecord(event) &&
        typeof event.event === "string" &&
        ["chat", "agent", "sessions.changed", "session.message"].includes(event.event)
          ? [{ event, index }]
          : [],
      );
      return {
        observedEventCount: params.events.length,
        relevantEventCount: relevant.length,
        frames: relevant.slice(-128).map(({ event, index }) => {
          const payload = isRecord(event.payload) ? event.payload : {};
          const session = isRecord(payload.session) ? payload.session : {};
          const data = payload.stream === "lifecycle" && isRecord(payload.data) ? payload.data : {};
          return {
            index,
            event: scalar(event.event),
            envelope: pick(event, ["seq"]),
            payload: pick(payload, runFields),
            activeRunIds: activeRuns(payload.activeRunIds),
            session: pick(session, runFields),
            sessionActiveRunIds: activeRuns(session.activeRunIds),
            payloadErrorText: textFacts(payload.lastRunError),
            sessionErrorText: textFacts(session.lastRunError),
            lifecycleErrorText: textFacts(data.error),
            chatErrorText: textFacts(payload.errorMessage),
            message: messageFacts(payload.message),
            lifecycle: {
              ...pick(data, [
                "phase",
                "error",
                "startedAt",
                "endedAt",
                "stopReason",
                "timeoutPhase",
                "providerStarted",
                "aborted",
                "livenessState",
                "yielded",
                "executionSettled",
              ]),
              errorDetail: pick(data.errorObservation, detailFields),
            },
            chatErrorDetail: pick(payload.errorDetail, detailFields),
          };
        }),
      };
    });
    const terminal =
      params.terminal === undefined
        ? { status: "unobserved" as const }
        : observe(() => ({
            ...pick(params.terminal, waitFields),
            errorText: textFacts(isRecord(params.terminal) ? params.terminal.error : undefined),
          }));
    const logs = observe(() => params.instance.logs());
    const primaryError = observe(() =>
      scalar(params.error instanceof Error ? params.error.message : params.error),
    );
    const { redactSensitiveText } = await import("../../../../src/logging/redact.js");
    const { projectChatErrorDetail } =
      await import("../../../../packages/gateway-protocol/src/schema/logs-chat.js");
    const masks = [
      ...params.fixtureSecrets,
      params.instance.gatewayToken,
      params.instance.hookToken,
      params.instance.configPath,
      params.instance.state.root,
      params.instance.homeDir,
      process.cwd(),
      process.env.HOME,
      process.env.TMPDIR,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .toSorted((a, b) => b.length - a.length);
    const sanitize = (value: string) => {
      for (const mask of masks) {
        value = value.replaceAll(mask, "[redacted]");
      }
      return redactSensitiveText(value, { mode: "tools" });
    };
    let truncatedScalarCount = 0;
    const sanitizeFacts = <T>(value: T): T =>
      JSON.parse(
        JSON.stringify(value, (_key, field: unknown) => {
          if (typeof field !== "string") {
            return field;
          }
          const redacted = sanitize(field);
          truncatedScalarCount += Number(redacted.length > 512);
          return redacted.slice(0, 512);
        }),
      ) as T;
    const captured = sanitizeFacts({ snapshotAt, chronology, terminal, primaryError });
    if (captured.chronology.status === "observed") {
      const value = captured.chronology.value;
      for (const frame of value.frames) {
        frame.lifecycle.errorDetail = pick(
          projectChatErrorDetail(frame.lifecycle.errorDetail),
          detailFields,
        );
        frame.chatErrorDetail = pick(projectChatErrorDetail(frame.chatErrorDetail), detailFields);
      }
      while (Buffer.byteLength(JSON.stringify(value.frames)) > 64 * 1024) {
        value.frames.shift();
      }
    }
    const rowStartedAt = Date.now();
    let row: unknown;
    try {
      const { loadSessionEntryReadOnly } =
        await import("../../../../src/config/sessions/session-accessor.js");
      const { resolveSessionStorePathCore } =
        await import("../../../../src/config/sessions/paths.js");
      const entry = loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey: params.sessionKey,
        storePath: resolveSessionStorePathCore(undefined, {
          agentId: "main",
          env: params.instance.env,
        }),
        env: params.instance.env,
        readConsistency: "latest",
        hydrateSkillPromptRefs: false,
      });
      row = {
        status: entry ? "observed" : "unobserved",
        startedAt: rowStartedAt,
        endedAt: Date.now(),
        fields: pick(entry, [...runFields, "authProfileOverride", "authProfileOverrideSource"]),
        errorText: textFacts(entry?.lastRunError),
      };
    } catch (rowError) {
      row = {
        status: "unobserved",
        startedAt: rowStartedAt,
        endedAt: Date.now(),
        error: scalar(rowError instanceof Error ? rowError.message : rowError),
      };
    }
    const projectedRow = sanitizeFacts(row);
    const historyStartedAt = Date.now();
    let history: unknown;
    try {
      // One existing native read after the snapshot; no polling or extra state discovery.
      const result = await params.client.request<unknown>(
        "chat.history",
        { agentId: "main", sessionKey: params.sessionKey, limit: 10 },
        { timeoutMs: 5_000 },
      );
      const returned = isRecord(result) ? result : {};
      const messages = Array.isArray(returned.messages) ? returned.messages : undefined;
      history = {
        status: "observed",
        startedAt: historyStartedAt,
        endedAt: Date.now(),
        session: pick(returned, runFields),
        sessionInfo: pick(returned.sessionInfo, runFields),
        sessionErrorText: textFacts(
          isRecord(returned.sessionInfo) ? returned.sessionInfo.lastRunError : undefined,
        ),
        messagesObserved: messages !== undefined,
        returnedMessageCount: messages?.length ?? null,
        omittedMessageCount: messages ? Math.max(0, messages.length - 10) : null,
        messages: messages?.slice(-10).map(messageFacts) ?? null,
        projection:
          "chat.history returned representation; correlation does not establish original entry ownership",
      };
    } catch (historyError) {
      history = {
        status: "unobserved",
        startedAt: historyStartedAt,
        endedAt: Date.now(),
        error: scalar(historyError instanceof Error ? historyError.message : historyError),
      };
    }
    const projectedHistory = sanitizeFacts(history);
    const logTail = observe(() => {
      if (logs.status !== "observed") {
        return { status: "unobserved" };
      }
      const redacted = sanitize(logs.value);
      return {
        status: "observed",
        tail: redacted.slice(-8192),
        omittedChars: Math.max(0, redacted.length - 8192),
        source: "existing bounded instance.logs buffer at snapshotAt",
      };
    });
    const frames =
      captured.chronology.status === "observed" ? captured.chronology.value : undefined;
    console.error(
      "[qa-codex-failure-snapshot] " +
        JSON.stringify({
          configuredProfileId: params.configuredProfileId,
          sessionKey: params.sessionKey,
          runId: params.runId || null,
          ...captured,
          retainedFrameCount: frames?.frames.length ?? null,
          omittedFrameCount: frames ? frames.relevantEventCount - frames.frames.length : null,
          scalarLimitChars: 512,
          truncatedScalarCount,
          frameLimit: 128,
          frameLimitBytes: 64 * 1024,
          missingOrNonScalarFields: "null (unobserved, not false)",
          postSnapshotRow: projectedRow,
          postSnapshotHistory: projectedHistory,
          postSnapshotObservationsAreAtomic: false,
          logTail,
          logTailLimitChars: 8192,
        }),
    );
  } catch {
    try {
      console.error("[qa-codex-failure-snapshot] capture unavailable; primary failure retained");
    } catch {
      // Never replace the original test exception with a diagnostic output error.
    }
  }
}
