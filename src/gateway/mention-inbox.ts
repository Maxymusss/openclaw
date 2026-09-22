import { createHash } from "node:crypto";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  MAX_EVERYONE_MENTION_RECIPIENTS,
  MAX_HUMAN_MENTIONS,
  errorShape,
  type ErrorShape,
  type MentionInboxItem,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { hasRetainedSessionPendingInput } from "../config/sessions/session-accessor.pending-input-sources.js";
import { updateSessionMentionProfileInvolvement } from "../config/sessions/session-accessor.sqlite-involvement.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import type { HumanMentionWebPush } from "./event-web-push.js";
import { createHumanMentionPolicy } from "./human-mention-policy.js";
import { createMentionInboxPersistence } from "./mention-inbox-persistence.js";
import {
  projectMentionInboxItem,
  mentionTargetAccessIdentity,
  resolveCommittedMentionTarget,
  resolveIncognitoMentionTarget,
} from "./mention-inbox-projection.js";
import { createMentionInboxSourceIndex, type StoredMention } from "./mention-inbox-source-index.js";
import { mentionSourceKey } from "./mention-inbox-store.js";
import type {
  MentionReadResult,
  MentionWorkerOperations,
} from "./mention-inbox-worker-contract.js";
import type { MentionInbox } from "./mention-inbox.types.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";

const MAX_GLOBAL_ITEMS = 10_000;
const log = createSubsystemLogger("gateway/mentions");

type SharingTargets = Map<string, { sessionKey: string; target: SessionSharingTarget | null }>;

/** Durable sources own retention and replay; each Gateway keeps disposable projection indexes. */
export function createMentionInbox(params: {
  gatewayInstanceId: string;
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onMentionCreated?: (notification: HumanMentionWebPush) => void;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}): MentionInbox {
  const sourceIndex = createMentionInboxSourceIndex();
  const { items, itemsByProfile, processed } = sourceIndex;
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  const connectedTargets: SharingTargets = new Map();
  let active = true;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let profileInvalidationPending = false;
  let refreshPending: Promise<void> | undefined;
  let audienceExpiryAt = Infinity;
  let maintainedProfileVersion = -1;
  let targetConfig: OpenClawConfig | undefined;
  let pendingCommittedInputs = 0;
  const assertActive = () => {
    if (!active) {
      throw new Error("The mention Inbox is unavailable");
    }
  };
  const persistence = createMentionInboxPersistence({
    revision: () => sourceIndex.head.revision,
    install,
    assertActive,
  });
  const { enqueue, readStore } = persistence;
  async function mutate(
    operation: MentionWorkerOperations["mentions.mutate"]["input"]["operation"],
    assertCurrent = assertActive,
  ) {
    const profileVersion = readUserProfileVersion();
    const result = await persistence.mutate(operation, assertCurrent);
    maintainedProfileVersion = profileVersion;
    return result;
  }
  const resolveTarget = (input: { sessionKey: string; agentId?: string }) =>
    resolveCommittedMentionTarget(
      params.getRuntimeConfig(),
      params.getSessionRowProjection?.(),
      input,
    );
  const policy = createHumanMentionPolicy({
    ...params,
    resolveTarget(input) {
      return (
        resolveTarget(input) ?? resolveIncognitoMentionTarget(params.getRuntimeConfig(), input)
      );
    },
  });
  async function preparePolicy() {
    const projection = params.getSessionRowProjection?.();
    if (!projection) {
      throw new Error("Mention session projection is unavailable");
    }
    while (projection.needsMaterialization) {
      await projection.ensureMaterialized();
    }
    assertActive();
  }
  function install(result: Pick<MentionReadResult, "snapshot" | "audienceExpiryAt">) {
    if (result.snapshot) {
      sourceIndex.hydrate(result.snapshot);
    }
    audienceExpiryAt = result.audienceExpiryAt;
  }
  async function maintain() {
    const before = sourceIndex.head.revision;
    const result = await readStore({ cleanup: pendingCommittedInputs === 0 });
    if (
      Date.now() >= Math.min(sourceIndex.nextExpiryAt, audienceExpiryAt) ||
      maintainedProfileVersion !== readUserProfileVersion()
    ) {
      const cleanup = [];
      for (const row of result.cleanup) {
        const retained = await hasRetainedSessionPendingInput(row.receipt, {
          idempotencyKey: row.receipt.sourceId,
          requestFingerprint: row.receipt.requestFingerprint,
        });
        cleanup.push({ ...row, retained });
      }
      // A source can commit while its worker observation is pending. Its synchronous
      // completion reservation wins before cleanup is admitted on this Inbox FIFO.
      await mutate({ kind: "maintain", cleanup: pendingCommittedInputs === 0 ? cleanup : [] });
    }
    await preparePolicy();
    return sourceIndex.head.revision !== before;
  }

  function currentTarget(item: StoredMention, cfg: OpenClawConfig, targets?: SharingTargets) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (!active || items.get(item.id) !== item || source.expiresAt <= Date.now()) {
      return undefined;
    }
    const key = JSON.stringify([agentId, sessionKey]);
    let resolved = targets?.get(key)?.target;
    if (resolved === undefined) {
      resolved = resolveTarget({ sessionKey, agentId });
      if (targets?.size === MAX_GLOBAL_ITEMS) {
        targets.clear();
      }
      targets?.set(key, { sessionKey, target: resolved });
    }
    if (!resolved || resolved.entry.sessionId !== message.sessionId) {
      return undefined;
    }
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const recipient = policy.recipientProfile(item.recipientProfileId, target, cfg);
    const sender = policy.readProfile(senderProfileId);
    return recipient && recipient.profileId !== sender?.profileId
      ? { target, recipient, sender }
      : undefined;
  }

  function readView(
    client: GatewayClient | null,
    cfg = params.getRuntimeConfig(),
    remember = true,
    targets: SharingTargets = new Map(),
  ): Result<MentionsListResult, ErrorShape> {
    const identified = policy.identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    const visible: MentionInboxItem[] = [];
    const profileItems = itemsByProfile.get(requester.profile.profileId);
    for (const item of [...(profileItems ?? [])].toReversed()) {
      const current = currentTarget(item, cfg, targets);
      if (current && requester.canRead(current.target)) {
        visible.push(projectMentionInboxItem(item, current));
      }
    }
    const signature = createHash("sha256")
      .update(JSON.stringify([requester.profile.profileId, visible]))
      .digest("hex");
    const previous = client && views.get(client);
    const revision = previous ? previous.revision + Number(signature !== previous.signature) : 0;
    if (client && remember) {
      views.set(client, { signature, revision });
    }
    return ok({ gatewayInstanceId: params.gatewayInstanceId, revision, items: visible });
  }

  function refreshConnectedViews(): void {
    const cfg = params.getRuntimeConfig();
    if (targetConfig !== cfg) {
      connectedTargets.clear();
      targetConfig = cfg;
    }
    for (const client of params.getClients()) {
      if (!client.connId) {
        continue;
      }
      const previous = views.get(client);
      const result = readView(client, cfg, true, connectedTargets);
      if (
        !result.ok ||
        (previous ? previous.revision === result.value.revision : result.value.items.length === 0)
      ) {
        continue;
      }
      params.broadcastToConnIds(
        "mentions.changed",
        { gatewayInstanceId: params.gatewayInstanceId, revision: result.value.revision },
        new Set([client.connId]),
      );
    }
  }

  function scheduleExpiry(retryAfterMs?: number, rearm = false): void {
    if (rearm && expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    if (
      expiryTimer ||
      !active ||
      closing ||
      (processed.size === 0 &&
        (audienceExpiryAt === Infinity || pendingCommittedInputs > 0) &&
        retryAfterMs === undefined)
    ) {
      return;
    }
    expiryTimer = runInDetachedAsyncContext(() =>
      setTimeout(
        () => {
          expiryTimer = undefined;
          refresh();
        },
        retryAfterMs ??
          Math.max(
            1,
            Math.min(
              sourceIndex.nextExpiryAt,
              pendingCommittedInputs > 0 ? Infinity : audienceExpiryAt,
            ) - Date.now(),
          ),
      ),
    );
    expiryTimer.unref?.();
  }

  function refresh(): void {
    if (closing || refreshPending || !params.getSessionRowProjection?.()) {
      return;
    }
    refreshPending = enqueue(undefined, async () => {
      await maintain();
      refreshConnectedViews();
      scheduleExpiry();
    })
      .catch(() => {
        if (!closing) {
          log.warn("Unable to refresh the mention Inbox; current reads will retry.");
          scheduleExpiry(60_000);
        }
      })
      .finally(() => {
        refreshPending = undefined;
      });
  }

  function invalidateTargets(sessionKey?: string): void {
    if (!sessionKey) {
      connectedTargets.clear();
      return;
    }
    for (const [key, cached] of connectedTargets) {
      if (cached.sessionKey === sessionKey || cached.target?.storeKeys.includes(sessionKey)) {
        connectedTargets.delete(key);
      }
    }
  }

  function invalidate(sessionKey?: string): void {
    invalidateTargets(sessionKey);
    policy.invalidateDirectory();
    refresh();
  }

  // Only connected-view refreshes retain targets across calls. Committed row publications
  // invalidate them; direct reads and delayed push authority keep their fresh exact reads.
  const stopRows = sessionChanges.subscribe((change) =>
    invalidateTargets("sessionKey" in change ? change.sessionKey : undefined),
  );

  // Profile writes publish after commit. The microtask also follows role-policy cache invalidation.
  const stopProfiles = onUserProfilesChanged(() => {
    if (profileInvalidationPending) {
      return;
    }
    profileInvalidationPending = true;
    queueMicrotask(() => {
      profileInvalidationPending = false;
      invalidate();
    });
  });
  const stopSessions = onSessionIdentityMutation(() => invalidate());

  function unavailable(warn = false): Result<never, ErrorShape> {
    if (warn) {
      log.warn("The mention Inbox could not read or save its current state. Reconnect to retry.");
    }
    return err(
      errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
        retryable: true,
      }),
    );
  }

  function readOperation<T>(operation: () => Result<T, ErrorShape>): Result<T, ErrorShape> {
    if (active && !closing) {
      try {
        return operation();
      } catch {
        return unavailable(true);
      }
    }
    return unavailable();
  }

  refresh();

  return {
    async mentionable(client, input, publish) {
      let preparationFailure: Result<never, ErrorShape> | undefined;
      try {
        await preparePolicy();
        // A committed profile change can invalidate preparation before this continuation runs.
        while (policy.needsDirectoryPreparation()) {
          await policy.prepareDirectory();
        }
      } catch {
        preparationFailure = unavailable(true);
      }
      // Current policy selection and response publication must not cross another await.
      publish(preparationFailure ?? readOperation(() => policy.mentionable(client, input)));
    },
    validateRecipients: (...args: Parameters<typeof policy.validateRecipients>) =>
      readOperation(() => policy.validateRecipients(...args)),
    async prepareRecipients(everyone) {
      try {
        await preparePolicy();
        if (everyone) {
          while (policy.needsDirectoryPreparation()) {
            await policy.prepareDirectory();
          }
        }
        await preparePolicy();
        return active && !closing ? ok(undefined) : unavailable();
      } catch {
        return unavailable(true);
      }
    },
    resolveEveryoneRecipients: (...args: Parameters<typeof policy.resolveEveryoneRecipients>) =>
      readOperation(() => policy.resolveEveryoneRecipients(...args)),
    retainEveryoneAudience(client, sourceIdentity, sourceOptions) {
      const identity = { ...sourceIdentity };
      const options =
        "recipients" in sourceOptions
          ? { ...sourceOptions, recipients: [...sourceOptions.recipients] }
          : { ...sourceOptions };
      return enqueue(
        { identity, recipients: "recipients" in options ? options.recipients : undefined },
        async () => {
          await maintain();
          const assertCurrent = () => {
            options.assertCurrent();
            const identified = policy.identify(client, params.getRuntimeConfig());
            const resolved = resolveTarget(identity);
            if (
              !identified.ok ||
              identified.value.profile.profileId !== identity.senderProfileId ||
              !resolved ||
              resolved.entry.sessionId !== identity.sessionId ||
              resolved.entry.incognito ||
              isIncognitoSessionKey(resolved.canonicalKey) ||
              !identified.value.canRead({
                agentId: resolved.agentId,
                sessionKey: resolved.canonicalKey,
                entry: resolved.entry,
              })
            ) {
              throw new Error("Mention audience no longer owns its admitted sender and session");
            }
          };
          assertCurrent();
          await mutate(
            {
              kind: "retain",
              identity,
              recovered: options.recovered,
              recipients: "recipients" in options ? options.recipients : undefined,
            },
            assertCurrent,
          );
          scheduleExpiry();
        },
      );
    },
    async list(client, publish) {
      let result: Result<MentionsListResult, ErrorShape>;
      try {
        await enqueue(undefined, async () => {
          if (await maintain()) {
            refreshConnectedViews();
          }
          scheduleExpiry();
        });
        await preparePolicy();
        result = readOperation(() => readView(client));
      } catch {
        result = unavailable(true);
      }
      publish(result);
    },
    async dismiss(client, requestedIds, publish) {
      const ids = [...requestedIds];
      let result: Result<MentionsListResult, ErrorShape>;
      try {
        await enqueue(ids, async () => {
          await maintain();
          const current = readView(client, params.getRuntimeConfig(), false);
          if (!current.ok) {
            throw new Error(current.error.message);
          }
          const identified = policy.identify(client, params.getRuntimeConfig());
          if (!identified.ok) {
            throw new Error(identified.error.message);
          }
          const profileId = identified.value.profile.profileId;
          const owned = new Set(current.value.items.map((item) => item.id));
          const selected = ids.filter((id) => owned.has(id));
          const assertCurrent = () => {
            const latest = policy.identify(client, params.getRuntimeConfig());
            const view = readView(client, params.getRuntimeConfig(), false);
            if (
              !latest.ok ||
              latest.value.profile.profileId !== profileId ||
              !view.ok ||
              selected.some((id) => !view.value.items.some((item) => item.id === id))
            ) {
              throw new Error("Mention dismissal authority changed");
            }
          };
          await mutate({ kind: "dismiss", profileId, ids: selected }, assertCurrent);
          await preparePolicy();
          refreshConnectedViews();
          scheduleExpiry();
        });
        await preparePolicy();
        result = readOperation(() => readView(client));
      } catch {
        result = unavailable(true);
      }
      publish(result);
    },
    reserveCommittedInput() {
      if (closing) {
        return async () => {};
      }
      pendingCommittedInputs++;
      const complete = persistence.reserveCommitted();
      let pending: Promise<void> | undefined;
      return (run) =>
        (pending ??= complete(run).finally(() => {
          pendingCommittedInputs--;
          if (pendingCommittedInputs === 0) {
            scheduleExpiry(undefined, true);
          }
        }));
    },
    recordCommittedInput(sourceInput) {
      const input = structuredClone(sourceInput);
      if (!active || (!input.recipientProfileIds.length && !input.everyoneAudience)) {
        return Promise.resolve();
      }
      pendingCommittedInputs++;
      return enqueue(input, async () => {
        const identity = input.everyoneAudience?.identity;
        if (
          identity &&
          (identity.agentId !== input.agentId ||
            identity.sessionKey !== input.sessionKey ||
            identity.sessionId !== input.sessionId ||
            identity.sourceId !== input.sourceId ||
            identity.senderProfileId !== input.senderProfileId)
        ) {
          throw new Error("Mention audience does not match its committed source");
        }
        const observed = await readStore({ identity });
        await preparePolicy();
        const selected = [
          ...input.recipientProfileIds,
          ...(input.everyoneAudience?.retained && observed.audience
            ? observed.audience.recipients
            : []),
        ];
        const recipients = [
          ...new Set(selected.map((id) => policy.readProfile(id)?.profileId ?? id)),
        ];
        const references = [
          input.sourceId,
          input.sessionId,
          input.messageId,
          input.senderProfileId,
          ...recipients,
        ];
        if (
          input.recipientProfileIds.length > MAX_EVERYONE_MENTION_RECIPIENTS + MAX_HUMAN_MENTIONS ||
          recipients.length > MAX_EVERYONE_MENTION_RECIPIENTS ||
          input.sessionKey.length > 512 ||
          references.some((id) => !id || id.length > 256)
        ) {
          throw new Error("Invalid committed mention references");
        }
        const cfg = params.getRuntimeConfig();
        const resolved = resolveTarget(input);
        const target =
          resolved &&
          resolved.entry.sessionId === input.sessionId &&
          !resolved.entry.incognito &&
          !isIncognitoSessionKey(resolved.canonicalKey)
            ? {
                agentId: resolved.agentId,
                sessionKey: resolved.canonicalKey,
                entry: resolved.entry,
              }
            : undefined;
        const sender = target && policy.recipientProfile(input.senderProfileId, target, cfg);
        const allowed =
          target && sender
            ? recipients.filter(
                (id) => id !== sender.profileId && policy.recipientProfile(id, target, cfg),
              )
            : [];
        const profileVersion = readUserProfileVersion();
        const configuredPolicy = JSON.stringify([cfg.gateway?.roles, cfg.session?.sharing]);
        const capturedAccess = mentionTargetAccessIdentity(resolved);
        const assertCurrent = () => {
          if (
            readUserProfileVersion() !== profileVersion ||
            JSON.stringify([
              params.getRuntimeConfig().gateway?.roles,
              params.getRuntimeConfig().session?.sharing,
            ]) !== configuredPolicy ||
            mentionTargetAccessIdentity(resolveTarget(input)) !== capturedAccess
          ) {
            throw new Error("Mention authority changed while preparing its commit");
          }
          if (target && resolveTarget(input)?.entry.sessionId !== input.sessionId) {
            throw new Error("Mention session changed");
          }
        };
        // The existing agent owner keeps involvement separate from the atomic Inbox transaction.
        if (
          target &&
          resolved &&
          allowed.length &&
          !processed.has(
            mentionSourceKey({ ...target, sessionId: input.sessionId, sourceId: input.sourceId }),
          )
        ) {
          await updateSessionMentionProfileInvolvement(
            {
              agentId: resolved.agentId,
              sessionKey: resolved.storeKey,
              storePath: resolved.storePath,
            },
            {
              expectedSessionId: input.sessionId,
              profileIds: allowed,
              source: input.committedSource,
            },
            assertCurrent,
          );
          await preparePolicy();
        }
        const excerpt = input.excerpt
          ? truncateUtf16Safe(
              flattenMarkdownToPlainText(truncateUtf16Safe(input.excerpt, 2048))
                .replace(/[\p{Cc}\p{Cf}]/gu, " ")
                .replace(/\s+/gu, " ")
                .trim(),
              280,
            )
          : undefined;
        const committed = await mutate(
          {
            kind: "commit",
            input,
            audience: observed.audience,
            recipients,
            allowed,
            excerpt,
            target: target
              ? {
                  agentId: target.agentId,
                  sessionKey: target.sessionKey,
                  senderProfileId: sender?.profileId ?? input.senderProfileId,
                }
              : undefined,
          },
          assertCurrent,
        );
        await preparePolicy();
        refreshConnectedViews();
        scheduleExpiry();
        if (committed.capacityReached) {
          log.warn(
            "Mention retention reached its replay budget; alerts are skipped until retained sources expire.",
          );
        }
        for (const id of committed.createdIds) {
          const item = items.get(id),
            current = item && currentTarget(item, params.getRuntimeConfig());
          if (!item || !current || !params.onMentionCreated) {
            continue;
          }
          const projected = projectMentionInboxItem(item, current);
          params.onMentionCreated({
            id,
            recipientProfileId: current.recipient.profileId,
            sessionKey: projected.sessionKey,
            agentId: projected.agentId,
            senderLabel: projected.senderLabel,
            sessionTitle: projected.sessionTitle,
            prepareCurrent: () =>
              enqueue(undefined, async () => {
                await maintain();
              }),
            isCurrent: () => {
              if (!active || closing) {
                return false;
              }
              const latest = items.get(id);
              return Boolean(latest && currentTarget(latest, params.getRuntimeConfig()));
            },
          });
        }
      })
        .catch(() => {
          log.warn("Mention delivery could not be completed; the posted message is unchanged.");
        })
        .finally(() => {
          pendingCommittedInputs--;
          if (pendingCommittedInputs === 0) {
            scheduleExpiry(undefined, true);
          }
        });
    },
    invalidate,
    dispose() {
      if (closePromise) {
        return closePromise;
      }
      closing = true;
      stopProfiles();
      stopSessions();
      stopRows();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
      }
      closePromise = persistence.close().then(() => {
        active = false;
        connectedTargets.clear();
        policy.dispose();
        sourceIndex.clear();
      });
      return closePromise;
    },
  };
}
