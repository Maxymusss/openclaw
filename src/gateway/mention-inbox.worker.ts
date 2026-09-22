import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { MAX_EVERYONE_MENTION_RECIPIENTS } from "../../packages/gateway-protocol/src/schema/human-mentions.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { selectResolvedUserProfileMetadataById } from "../state/user-profiles-internal.js";
import {
  applyMentionAudienceCleanup,
  consumeMentionAudience,
  nextMentionAudienceExpiry,
  readMentionAudience,
  readMentionAudienceCleanup,
  retainMentionAudience,
} from "./mention-inbox-audience-store.js";
import { createMentionInboxSourceIndex, type StoredMention } from "./mention-inbox-source-index.js";
import {
  MAX_MENTION_SOURCES,
  MAX_MENTION_SOURCE_RECIPIENTS,
  MENTION_RETENTION_MS,
  mentionSourceChunkKey,
  mentionSourceKey,
  readMentionStoreSnapshot,
  writeMentionStoreChanges,
} from "./mention-inbox-store.js";
import type {
  MentionReadInput,
  MentionReadResult,
  MentionWorkerOperations,
} from "./mention-inbox-worker-contract.js";

export function readMentionInboxInDatabase(
  db: DatabaseSync,
  input: MentionReadInput,
): MentionReadResult {
  return runSqliteDeferredTransactionSync(
    db,
    () => ({
      snapshot: readMentionStoreSnapshot(input.revision, db),
      audience: input.identity ? readMentionAudience(db, input.identity) : undefined,
      audienceExpiryAt: nextMentionAudienceExpiry(db),
      cleanup: input.cleanup ? readMentionAudienceCleanup(db, input.now) : [],
    }),
    { operationLabel: "mentions.read" },
  );
}

/** Only this worker transaction changes Inbox sources and their private audience receipts. */
export function executeMentionMutation(
  input: MentionWorkerOperations["mentions.mutate"]["input"],
  database: OpenClawStateDatabase,
): MentionWorkerOperations["mentions.mutate"]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const canonicalProfiles = new Map<string, string>();
      const canonicalProfile = (id: string) => {
        let canonical = canonicalProfiles.get(id);
        if (canonical === undefined) {
          canonical = selectResolvedUserProfileMetadataById(db, id)?.id ?? id;
          canonicalProfiles.set(id, canonical);
        }
        return canonical;
      };
      const index = createMentionInboxSourceIndex(canonicalProfile);
      index.hydrate(readMentionStoreSnapshot(-1, db)!);
      index.expireItems(input.now);
      index.reconcileProfiles();
      const operation = input.operation;
      const createdIds: string[] = [];
      let capacityReached = false;
      if (operation.kind === "maintain") {
        applyMentionAudienceCleanup(db, operation.cleanup, input.now);
      } else if (operation.kind === "retain") {
        const recipients = operation.recovered
          ? readMentionAudience(db, operation.identity)?.recipients
          : operation.recipients;
        if (!recipients) {
          throw new Error("Mention audience custody expired or is unavailable; submit a new turn");
        }
        retainMentionAudience(db, operation.identity, recipients, input.now);
      } else if (operation.kind === "dismiss") {
        for (const id of operation.ids) {
          const item = index.items.get(id);
          if (item?.recipientProfileId === operation.profileId) {
            index.removeItem(item);
          }
        }
      } else {
        const { input: source, target } = operation;
        const identity = source.everyoneAudience?.identity;
        const current = identity ? readMentionAudience(db, identity) : undefined;
        // A changed/expired receipt cannot adopt prepared recipients from another observation.
        if (!isDeepStrictEqual(current, operation.audience)) {
          throw new Error("Mention audience changed before consumption");
        }
        if (identity) {
          consumeMentionAudience(db, identity);
        }
        const recipientIds = [...new Set(operation.recipients.map(canonicalProfile))];
        if (recipientIds.length > MAX_EVERYONE_MENTION_RECIPIENTS) {
          throw new Error("Invalid mention recipient count");
        }
        if (target && recipientIds.length) {
          const sourceKey = mentionSourceKey({
            ...target,
            sessionId: source.sessionId,
            sourceId: source.sourceId,
          });
          if (!index.processed.has(sourceKey)) {
            const count = Math.ceil(recipientIds.length / MAX_MENTION_SOURCE_RECIPIENTS);
            capacityReached = index.processed.size + count > MAX_MENTION_SOURCES;
            if (!capacityReached) {
              const now = input.now;
              const chunks = Array.from({ length: count }, (_, i) => {
                const key = mentionSourceChunkKey(sourceKey, i);
                const chunk = index.createSource(
                  key,
                  index.head.nextSequence++,
                  now + MENTION_RETENTION_MS,
                );
                chunk.rootKey = sourceKey;
                index.processed.set(key, chunk);
                index.dirtySources.add(key);
                return chunk;
              });
              const allowed = new Set(operation.allowed);
              const message: StoredMention["message"] = {
                sessionId: source.sessionId,
                content: {
                  ...target,
                  messageId: source.messageId,
                  createdAt: now,
                  ...(operation.excerpt ? { excerpt: operation.excerpt } : {}),
                },
              };
              for (const [i, id] of recipientIds.entries()) {
                const chunk = chunks[Math.floor(i / MAX_MENTION_SOURCE_RECIPIENTS)]!;
                chunk.recipients.set(id, null);
                if (!allowed.has(id) || id === target.senderProfileId) {
                  continue;
                }
                const item: StoredMention = {
                  id: randomUUID(),
                  recipientProfileId: id,
                  source: chunk,
                  message,
                };
                index.items.set(item.id, item);
                chunk.recipients.set(id, item);
                index.indexItem(item);
                index.trimItems(index.items, 10_000);
                createdIds.push(item.id);
              }
            }
          }
        }
      }
      writeMentionStoreChanges(db, index.head, index.changes(), input.now);
      const snapshot = readMentionStoreSnapshot(input.revision, db);
      const audienceExpiryAt = nextMentionAudienceExpiry(db);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return { snapshot, audienceExpiryAt, createdIds, capacityReached };
    },
    { database },
    { operationLabel: "mentions.write" },
  );
}
