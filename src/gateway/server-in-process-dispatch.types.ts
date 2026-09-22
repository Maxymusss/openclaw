import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

export type OperatorToolGatewayAuthority = {
  authenticatedUserProfile?: NonNullable<
    NonNullable<GatewayRequestOptions["client"]>["authenticatedUserProfile"]
  >;
  scopes: readonly string[];
  operatorRoleActor?: GatewayOperatorRoleActor;
  operatorRunAuthority?: AdmittedRunOperatorAuthority;
  signal: AbortSignal;
  assertCurrent?: () => void;
};

export type GatewayMethodDispatchResponse = {
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
  meta?: Record<string, unknown>;
};
