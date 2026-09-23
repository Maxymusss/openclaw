import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  registerGatewayModelCatalogPrivateAccess,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { handleChatMetadataRequest } from "./chat-metadata-handler.js";
import {
  createChatMetadataOwner,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

const allowed = "gpt-5.6-luna";
const forbidden = "zz-forbidden";
const sessionKey = "agent:main:catalog-access";
const isolated = {
  layout: "state-only",
  prefix: "catalog-agent-access-",
  env: WITHOUT_OPENAI_ENV_AUTH,
} as const;

function fixture() {
  const config = rolePolicyConfig();
  const role = expectDefined(config.gateway?.roles?.definitions.view, "view role");
  role.agents = ["guest"];
  role.scopes = ["operator.read"];
  role.sessions = { others: "none" };
  role.models = { allow: [`openai/${allowed}`] };
  config.agents = {
    ...createOpenAIChatMetadataConfig([allowed, forbidden]).agents,
    list: [{ id: "main", default: true }, { id: "guest" }],
  };
  const client = roleClient("view", "catalog-agent-reader");
  client.connect.scopes = ["operator.read"];
  const person = expectDefined(client.authenticatedUserProfile, "authenticated reader");
  const foreign = ensureProfileForEmail("other-catalog-reader@example.test");
  const owner = createChatMetadataOwner(config, allowed, {}, "openai", "openai-chatgpt-responses");
  const entries = [allowed, forbidden].map((id) => ({
    id,
    name: id,
    provider: "openai",
    api: "openai-chatgpt-responses" as const,
  }));
  const snapshot: PreparedGatewayModelCatalogSnapshot = {
    ...owner.modelCatalog,
    entries,
    routeVariants: entries,
    catalogComplete: false,
    agentId: "main",
    agentDir: owner.agentDir,
    workspaceDir: expectDefined(owner.workspaceDir, "workspace"),
    config,
    observationConfig: config,
    metadataSnapshot: owner.metadataSnapshot,
    isCurrent: () => owner.isCurrent(),
    authStore: expectDefined(getPreparedModelRuntimeAuthStore(owner), "auth store"),
    authModes: owner.authModes,
    authMaterializations: [],
  };
  let beforeRead = async () => {};
  const readPrepared = vi.fn(async () => {
    await beforeRead();
    return snapshot;
  });
  const loadDeferred = vi.fn(async () => snapshot);
  const loader = async () => snapshot;
  registerGatewayModelCatalogPrivateAccess(loader, { readPrepared, loadDeferred });
  const readMetadata = vi.fn(async () => {
    await beforeRead();
    return { models: entries, swarmEnabled: false };
  });
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: loader,
    readChatMetadata: readMetadata,
  });
  const write = async (ownerProfile: string | undefined) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "catalog-access-session",
        updatedAt: 1,
        ...(ownerProfile
          ? {
              createdActor: {
                type: "human" as const,
                source: "profile" as const,
                id: ownerProfile,
              },
            }
          : {}),
      },
    );
  const request = (method: "models.list" | "chat.metadata") => {
    const respond = vi.fn<RespondFn>();
    const params = { sessionKey, ...(method === "models.list" ? { view: "configured" } : {}) };
    const handler =
      method === "models.list"
        ? expectDefined(modelsHandlers[method], "models.list")
        : handleChatMetadataRequest;
    const pending = handler({
      req: { type: "req", id: "catalog-agent-access", method, params },
      params,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    });
    return { pending: Promise.resolve(pending), respond };
  };
  return {
    config,
    role,
    person,
    foreign,
    write,
    request,
    readPrepared,
    readMetadata,
    loadDeferred,
    hold: (read: typeof beforeRead) => {
      beforeRead = read;
    },
  };
}

it.each(
  (["models.list", "chat.metadata"] as const).flatMap((method) =>
    (["owned", "shared", "missing", "hidden", "foreign", "unrestricted-preview"] as const).map(
      (mode) => ({ method, mode }),
    ),
  ),
)("$method distinguishes $mode saved-row grants from draft keys", async ({ method, mode }) => {
  await withOpenClawTestState(isolated, async (state) => {
    const f = fixture();
    if (mode === "shared") {
      f.role.sessions = { others: "view" };
    }
    if (mode === "unrestricted-preview") {
      f.role.agents = "*";
      delete f.role.models;
    }
    await state.writeConfig(f.config);
    if (mode !== "missing" && mode !== "unrestricted-preview") {
      await f.write(
        mode === "hidden" ? undefined : mode === "owned" ? f.person.profileId : f.foreign.id,
      );
    }
    const { pending, respond } = f.request(method);
    if (mode === "hidden" || mode === "foreign") {
      await expect(pending).rejects.toThrow(`Session "${sessionKey}" was not found.`);
    } else {
      await pending;
      if (mode === "missing") {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: expect.stringContaining("no access to this agent"),
          }),
        );
      } else {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            models: (mode === "unrestricted-preview" ? [allowed, forbidden] : [allowed]).map((id) =>
              expect.objectContaining({ id, provider: "openai" }),
            ),
          }),
          ...(method === "models.list" ? [undefined] : []),
        );
      }
    }
    if (["missing", "hidden", "foreign"].includes(mode)) {
      expect(f.readPrepared).not.toHaveBeenCalled();
      expect(f.readMetadata).not.toHaveBeenCalled();
      expect(f.loadDeferred).not.toHaveBeenCalled();
    } else {
      expect(method === "models.list" ? f.readPrepared : f.readMetadata).toHaveBeenCalledOnce();
    }
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  });
});

it.each(
  (["models.list", "chat.metadata"] as const).flatMap((method) =>
    [false, true].map((saved) => ({ method, saved })),
  ),
)(
  "$method rechecks draft ceilings and saved visibility after catalog I/O (saved=$saved)",
  async ({ method, saved }) => {
    await withOpenClawTestState(isolated, async (state) => {
      const f = fixture();
      if (saved) {
        f.role.sessions = { others: "view" };
      } else {
        f.role.agents = ["main", "guest"];
      }
      await state.writeConfig(f.config);
      if (saved) {
        await f.write(f.foreign.id);
      }
      const entered = createDeferred();
      const release = createDeferred();
      f.hold(async () => {
        entered.resolve();
        await release.promise;
      });
      const { pending, respond } = f.request(method);
      const checked = saved
        ? expect(pending).rejects.toThrow(`Session "${sessionKey}" was not found.`)
        : expect(pending).resolves.toBeUndefined();
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Catalog hold missed");
          }),
        ]);
        if (saved) {
          f.role.sessions = { others: "none" };
        } else {
          f.role.agents = ["guest"];
        }
        release.resolve();
        await checked;
        if (!saved) {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: "FORBIDDEN",
              message: expect.stringContaining("no access to this agent"),
            }),
          );
        } else {
          expect(respond).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([pending, checked]);
      }
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    });
  },
);
