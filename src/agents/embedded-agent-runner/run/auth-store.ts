import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolveExternalCliAuthOverlayScopeFromSelection } from "../../auth-profiles/external-cli-auth-selection.js";
import type { AgentHarness } from "../../harness/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../../model-auth.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import { OPENAI_PROVIDER_ID } from "../../openai-routing.js";
import { prepareSelectedAgentRuntimeAuthProfile } from "../../runtime-plan/prepare-auth.js";
import type { RuntimeAuthState } from "./helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ResolvedProviderAuth | null;
  runtimeAuthState: RuntimeAuthState | null;
  pluginHarnessOwnsTransport: boolean;
}): string | undefined {
  if (params.runtimeAuthState) {
    // Core streaming consumes the provider-prepared runtime credential from
    // authStorage. A transport-owning harness instead needs the original
    // resolved profile credential promised by its attempt contract.
    return params.pluginHarnessOwnsTransport ? params.runtimeAuthState.sourceApiKey : undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

export function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: string | undefined | string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((profileId) => profileId?.trim())
    .filter((profileId): profileId is string => Boolean(profileId));
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  const scopedRuntimeExternalProfileIds = (store.runtimeExternalProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  const scopedRuntimePersistedProfileIds = (store.runtimePersistedProfileIds ?? []).filter(
    (profileId) => scopedProfiles[profileId],
  );
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
        ...(scopedRuntimePersistedProfileIds.length > 0
          ? { runtimePersistedProfileIds: scopedRuntimePersistedProfileIds }
          : {}),
        ...(scopedRuntimeExternalProfileIds.length > 0 ||
        store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIds: scopedRuntimeExternalProfileIds }
          : {}),
        ...(store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIdsAuthoritative: true }
          : {}),
      }
    : createEmptyAuthProfileStore();
}

/** Preserve scoped runtime snapshots, external overlays and publication at both admission points. */
export function loadEmbeddedRunAuthProfileStore(params: {
  runParams: RunEmbeddedAgentParams;
  provider: string;
  modelId: string;
  modelApi?: string;
  agentDir: string;
  workspaceDir: string;
  harness: Pick<AgentHarness, "id" | "authBootstrap">;
  markStage?: (stage: string) => void;
}) {
  const runParams = params.runParams;
  const usesOpenAIAuthRouting = params.provider === OPENAI_PROVIDER_ID;
  const initialHarness = params.harness;
  const initialPluginHarnessOwnsTransport = initialHarness.id !== "openclaw";
  const openClawNativeCodexResponsesNeedsAuthBootstrap =
    !initialPluginHarnessOwnsTransport &&
    usesOpenAIAuthRouting &&
    params.modelApi === "openai-chatgpt-responses";
  let externalCliAuthScope = initialPluginHarnessOwnsTransport
    ? { ignoreAutoPreferredProfile: false }
    : openClawNativeCodexResponsesNeedsAuthBootstrap
      ? {
          providerIds: [OPENAI_PROVIDER_ID],
          ignoreAutoPreferredProfile: false,
        }
      : resolveExternalCliAuthOverlayScopeFromSelection({
          provider: params.provider,
          cfg: runParams.config,
          agentId: runParams.agentId,
          modelId: params.modelId,
          workspaceDir: params.workspaceDir,
          userPinnedAuthProfileId:
            runParams.authProfileIdSource === "user" ? runParams.authProfileId : undefined,
        });
  let noExternalAuthStore: AuthProfileStore | undefined;
  if (!initialPluginHarnessOwnsTransport && !externalCliAuthScope.providerIds) {
    noExternalAuthStore = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      migrationProvider: params.provider,
      config: runParams.config,
      profileId: runParams.authProfileId,
      allowKeychainPrompt: false,
    });
    externalCliAuthScope = resolveExternalCliAuthOverlayScopeFromSelection({
      provider: params.provider,
      cfg: runParams.config,
      agentId: runParams.agentId,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      store: noExternalAuthStore,
      userPinnedAuthProfileId:
        runParams.authProfileIdSource === "user" ? runParams.authProfileId : undefined,
    });
  }
  params.markStage?.("scope");

  const attemptAuthProfileStore = usesOpenAIAuthRouting
    ? ensureAuthProfileStore(params.agentDir, {
        migrationProvider: params.provider,
        profileId: runParams.authProfileId,
        config: runParams.config,
        externalCliProviderIds: [OPENAI_PROVIDER_ID],
        allowKeychainPrompt: false,
      })
    : initialPluginHarnessOwnsTransport
      ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
          migrationProvider: params.provider,
          config: runParams.config,
          profileId: runParams.authProfileId,
          allowKeychainPrompt: false,
        })
      : externalCliAuthScope.providerIds
        ? ensureAuthProfileStore(params.agentDir, {
            migrationProvider: params.provider,
            profileId: runParams.authProfileId,
            config: runParams.config,
            externalCliProviderIds: externalCliAuthScope.providerIds,
            allowKeychainPrompt: false,
          })
        : (noExternalAuthStore ??
          ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
            migrationProvider: params.provider,
            config: runParams.config,
            profileId: runParams.authProfileId,
            allowKeychainPrompt: false,
          }));
  params.markStage?.("store");

  return { usesOpenAIAuthRouting, externalCliAuthScope, attemptAuthProfileStore };
}

/** Admit only selected-profile absence before metadata; route eligibility remains late. */
export function admitEmbeddedRunSelectedAuthProfile(
  params: Parameters<typeof loadEmbeddedRunAuthProfileStore>[0] & {
    metadataSnapshot?: PluginMetadataSnapshot;
  },
): void {
  const { runParams, harness } = params;
  if (runParams.authProfileIdSource !== "user" || !runParams.authProfileId?.trim()) {
    return;
  }
  const { attemptAuthProfileStore } = loadEmbeddedRunAuthProfileStore(params);
  prepareSelectedAgentRuntimeAuthProfile({
    provider: params.provider,
    modelId: params.modelId,
    config: runParams.config,
    env: process.env,
    agentId: runParams.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
    authProfileStore: attemptAuthProfileStore,
    sessionAuthProfileId: runParams.authProfileId,
    sessionAuthProfileSource: runParams.authProfileIdSource,
    harnessId: harness.id,
    harnessRuntime: harness.id,
    harnessAuthBootstrap: harness.authBootstrap,
    allowHarnessAuthProfileForwarding: true,
  });
}
