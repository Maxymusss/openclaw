import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import {
  freezeOperatorPermissionCeiling,
  type OperatorPermissionCeiling,
} from "../shared/operator-permissions.js";

export type AdmittedRunOperatorAuthority = Readonly<{
  profileId: string;
  scopes: readonly string[];
  permissions?: OperatorPermissionCeiling;
  /** Original access dependency; null is proven independent, undefined is unclassified. */
  gatewayAccessGrant?: GatewayAccessGrantRef | null;
  assertCurrent: () => void;
  signal?: AbortSignal;
  /** Opaque original source identity used only to compare compatible queued input. */
  source?: object;
  /** Retains the original source independently of a foreground run or request. */
  retain?: () => () => void;
}>;

const operatorAuthorityIssuers = new WeakSet<object>();

/** Host-only construction; public reply options cannot manufacture a source capability. */
export function createAdmittedRunOperatorAuthority(
  source: AdmittedRunOperatorAuthority,
): AdmittedRunOperatorAuthority {
  const check = source.assertCurrent;
  const signal = source.signal;
  let revoked = false;
  const authority = Object.freeze({
    profileId: source.profileId,
    scopes: Object.freeze([...source.scopes]),
    permissions: freezeOperatorPermissionCeiling(source.permissions),
    gatewayAccessGrant: source.gatewayAccessGrant
      ? Object.freeze({ ...source.gatewayAccessGrant })
      : source.gatewayAccessGrant,
    source: source.source ?? Object.freeze({}),
    signal,
    retain: source.retain,
    assertCurrent: () => {
      if (revoked) {
        throw new Error("operator execution authority is no longer active");
      }
      try {
        signal?.throwIfAborted();
        check();
      } catch (error) {
        revoked = true;
        throw error;
      }
    },
  });
  operatorAuthorityIssuers.add(authority);
  return authority;
}

export function assertAdmittedRunOperatorAuthority(
  authority: unknown,
): asserts authority is AdmittedRunOperatorAuthority {
  if (!authority || typeof authority !== "object" || !operatorAuthorityIssuers.has(authority)) {
    throw new Error("operator run authority must be issued by the host");
  }
}
