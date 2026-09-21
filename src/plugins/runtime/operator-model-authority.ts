import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { runWithOperatorModelRequest } from "../../agents/operator-model-policy.js";
import {
  captureGatewayToolOperatorAuthority,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

/** Capture before the first await; a later ambient caller cannot replace this invocation's source. */
export function captureRuntimeOperatorModelAuthority() {
  const caller = getGatewayToolCallerIdentity();
  // Metadata-only wrappers carry routing, not an admitted system/operator source.
  // An admitted caller remains authoritative even when its source is system-owned.
  if (caller?.operationalRunInstance || caller?.operatorAuthority) {
    const authority = captureGatewayToolOperatorAuthority();
    if (!authority) {
      return undefined;
    }
    return { authority, release: authority.retain?.() ?? (() => {}) };
  }
  const original = runWithOperatorModelRequest(undefined, (authority) => authority);
  if (original) {
    return { authority: original, release: original.retain?.() ?? (() => {}) };
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.context ?? scope?.resolveGatewayContext?.();
  return scope?.client && context
    ? captureGatewayOperatorRunAuthority({
        client: scope.client,
        context,
        hasCurrentClientAuthority: scope.hasCurrentClientAuthority,
      })
    : undefined;
}

/** Retain the original source across lazy facade preparation and its owned cleanup. */
export function runWithRuntimeOperatorModelAuthority<T>(
  run: (authority: AdmittedRunOperatorAuthority | undefined) => Promise<T>,
): Promise<T> {
  return runWithAsyncWorkResources(async (onAcquired) => {
    const source = captureRuntimeOperatorModelAuthority();
    if (source) {
      onAcquired({ release: source.release });
    }
    return await runWithOperatorModelRequest(source?.authority, run);
  });
}
