import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-operator-authority.js";
import {
  assertOperatorModelAuthorityCurrent,
  isOperatorModelPolicyError,
  OperatorModelPolicyError,
  runWithOperatorModelRequest,
} from "../agents/operator-model-policy.js";
import { captureGatewayToolOperatorAuthority } from "../agents/tools/gateway-caller-context.js";
import { captureRuntimeOperatorModelAuthority } from "../plugins/runtime/operator-model-authority.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";

/** Capture denial is terminal too; Decision availability cannot replace an expired source. */
function captureCurrentSource<T>(capture: () => T): T {
  try {
    return capture();
  } catch (cause) {
    if (isOperatorModelPolicyError(cause)) {
      throw cause;
    }
    throw new OperatorModelPolicyError("Decision operator authority is no longer active.", {
      cause,
    });
  }
}

export function captureDecisionOperatorAuthority(): AdmittedRunOperatorAuthority | undefined {
  return captureCurrentSource(() =>
    runWithOperatorModelRequest(captureGatewayToolOperatorAuthority(), (original) => original),
  );
}

/** Capture at each lazy entrypoint; the existing resource owner joins the original source release. */
export function runWithDecisionOperatorAuthority<T>(run: () => Promise<T>): Promise<T> {
  return runWithAsyncWorkResources(async (onAcquired) => {
    assertOperatorDecisionRuntimeAllowed();
    const source = captureCurrentSource(captureRuntimeOperatorModelAuthority);
    if (source) {
      onAcquired({ release: source.release });
    }
    assertOperatorDecisionRuntimeAllowed(source?.authority);
    return await runWithOperatorModelRequest(source?.authority, run);
  });
}

/** No Decision provider has a qualified model or foreground execution contract. */
export function isOperatorDecisionRuntimeAllowed(
  authority?: AdmittedRunOperatorAuthority,
): boolean {
  return runWithOperatorModelRequest(undefined, (ambient) => {
    assertOperatorModelAuthorityCurrent(authority);
    return [ambient, authority].every(
      (source) => !source?.modelPolicy && source?.executionPolicy !== "foreground-only",
    );
  });
}

export function assertOperatorDecisionRuntimeAllowed(
  authority?: AdmittedRunOperatorAuthority,
): void {
  if (!isOperatorDecisionRuntimeAllowed(authority)) {
    throw new OperatorModelPolicyError(
      "Decision inference is unavailable under this operator authority.",
    );
  }
}
