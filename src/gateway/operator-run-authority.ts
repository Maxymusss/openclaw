import { isDeepStrictEqual } from "node:util";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import {
  onGatewayDeviceSourceRevoked,
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";

// Equal source tokens describe one authenticated connection, without retaining its socket or auth.
const operatorSources = new WeakMap<GatewayClient, object>();

/** Transfers the original operator restriction into accepted work, independently of its request. */
export async function captureGatewayOperatorRunAuthority(params: {
  client: GatewayClient | null;
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
  >;
  hasCurrentClientAuthority?: () => boolean;
  sourceAuthority?: Readonly<{
    assertCurrent: () => void;
    signal?: AbortSignal;
    gatewayAccessGrant?: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
  }> | null;
}): Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void } | undefined> {
  const inherited = params.client?.internal?.operatorRunAuthority;
  if (inherited !== undefined) {
    assertAdmittedRunOperatorAuthority(inherited);
    inherited.assertCurrent();
    const scopes = intersectOperatorScopes(inherited.scopes, params.client?.connect.scopes ?? []);
    const authority = roleScopesAllow({
      role: "operator",
      requestedScopes: inherited.scopes,
      allowedScopes: scopes,
    })
      ? inherited
      : createAdmittedRunOperatorAuthority({ ...inherited, scopes });
    return { authority, release: inherited.retain?.() ?? (() => {}) };
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const client = params.client;
  if (!client || actor?.kind !== "operator") {
    return undefined;
  }
  const profileId = actor.profileId;
  if (params.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway caller authority is no longer active.");
  }
  const releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const isSourceCurrent = readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const isGatewayCurrent = () =>
    !resolveGatewayContext ||
    (gatewayContext !== undefined && resolveGatewayContext() === gatewayContext);
  const sourceAuthority =
    params.sourceAuthority !== undefined
      ? params.sourceAuthority
      : client.internal?.operatorAccessAuthority;
  const scopes = Object.freeze([...(client.connect.scopes ?? [])]);
  let source = operatorSources.get(client);
  if (!source) {
    source = Object.freeze({});
    operatorSources.set(client, source);
  }
  let references = 1;
  let revoked = false;
  const revocation = new AbortController();
  const subscriptions: Array<(() => void) | undefined> = [];
  let preparedProfile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  const assertProfileCurrent = () => {
    try {
      const profile = preparedProfile?.readCurrentProfile();
      if (!profile || profile.profileId !== profileId) {
        throw new Error("operator profile is unavailable");
      }
      return profile;
    } catch (error) {
      throw new Error("operator source identity changed; start a new request", { cause: error });
    }
  };
  const resolveCurrentRole = () =>
    resolveOperatorRolePolicyForAssignment(
      profileId,
      assertProfileCurrent().assignedRole,
      getConfig(),
    );
  const assertRoleCurrent = () => {
    const policy = resolveCurrentRole();
    if (
      policy &&
      !roleScopesAllow({ role: "operator", requestedScopes: scopes, allowedScopes: policy.scopes })
    ) {
      throw new Error("Your operator role changed; reconnect before continuing.");
    }
  };
  const revoke = (reason: unknown) => {
    if (references > 0 && isGatewayCurrent()) {
      revoked = true;
      revocation.abort(reason);
    }
  };
  const recheck = (check: () => void) => {
    if (!revoked && references > 0 && isGatewayCurrent()) {
      try {
        check();
      } catch (error) {
        revoke(error);
      }
    }
  };
  const assertCurrent = () => {
    if (revoked || references === 0) {
      throw new Error("operator execution authority is no longer active");
    }
    try {
      if (isSourceCurrent?.() === false || !isGatewayCurrent()) {
        throw new Error("operator source authority is no longer active");
      }
      sourceAuthority?.signal?.throwIfAborted();
      sourceAuthority?.assertCurrent();
      sourceAuthority?.signal?.throwIfAborted();
      if (revoked || references === 0) {
        throw new Error("operator execution authority is no longer active");
      }
      assertRoleCurrent();
    } catch (error) {
      revoked = true;
      throw error;
    }
  };
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--references === 0) {
          for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe?.();
          }
          preparedProfile?.release();
          releaseDevice?.();
        }
      }
    };
  };
  const release = releaseHold();
  try {
    const preparationConfigs = [
      { gateway: { roles: structuredClone(getConfig().gateway?.roles) } },
    ];
    let onConfigChange = () => {
      preparationConfigs.push({ gateway: { roles: structuredClone(getConfig().gateway?.roles) } });
    };
    // The assignment arrives asynchronously. Keep committed policy changes until
    // it can be resolved, so revocation cannot disappear behind a later restore.
    subscriptions.push(
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === profileId) {
          revoke(new Error("Your operator role changed; reconnect before continuing."));
        } else if (
          change.kind === "config" &&
          change.context === (gatewayContext ?? params.context)
        ) {
          onConfigChange();
        }
      }),
    );
    preparedProfile = await prepareUserProfileIdentity(profileId);
    const currentActor = resolveGatewayOperatorRoleActor(params.client);
    if (
      params.client !== client ||
      currentActor?.kind !== "operator" ||
      currentActor.profileId !== profileId ||
      params.hasCurrentClientAuthority?.() === false ||
      !isGatewayCurrent() ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: scopes,
        allowedScopes: client.connect.scopes ?? [],
      })
    ) {
      throw new Error("Gateway caller authority is no longer active.");
    }
    const capturedAssignedRole = assertProfileCurrent().assignedRole;
    const capturedRole = structuredClone(resolveCurrentRole());
    if (
      preparationConfigs.some(
        (config) =>
          !isDeepStrictEqual(
            capturedRole,
            resolveOperatorRolePolicyForAssignment(profileId, capturedAssignedRole, config),
          ),
      )
    ) {
      revoke(new Error("Your operator role changed; reconnect before continuing."));
    }
    const assertCapturedRoleCurrent = () => {
      const current = assertProfileCurrent();
      const policy = resolveOperatorRolePolicyForAssignment(
        profileId,
        current.assignedRole,
        getConfig(),
      );
      if (
        current.assignedRole !== capturedAssignedRole ||
        !isDeepStrictEqual(capturedRole, policy)
      ) {
        throw new Error("Your operator role changed; reconnect before continuing.");
      }
    };
    onConfigChange = () => recheck(assertCapturedRoleCurrent);
    preparationConfigs.length = 0;
    subscriptions.push(
      onGatewayDeviceSourceRevoked(params.hasCurrentClientAuthority, () =>
        revoke(new Error("operator source authority is no longer active")),
      ),
      onUserProfilesChanged(() => recheck(assertCapturedRoleCurrent)),
    );
    const sourceSignal = sourceAuthority?.signal;
    if (sourceSignal) {
      const onAbort = () => revoke(sourceSignal.reason);
      sourceSignal.addEventListener("abort", onAbort, { once: true });
      subscriptions.push(() => sourceSignal.removeEventListener("abort", onAbort));
    }
    assertCurrent();
    return {
      authority: createAdmittedRunOperatorAuthority({
        profileId,
        scopes,
        gatewayAccessGrant: sourceAuthority === null ? null : sourceAuthority?.gatewayAccessGrant,
        source,
        assertCurrent,
        signal: revocation.signal,
        retain: () => {
          assertCurrent();
          references += 1;
          return releaseHold();
        },
      }),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
