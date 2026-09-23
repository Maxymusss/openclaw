import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-operator-authority.js";
import {
  assertOperatorModelAuthorityCurrent,
  isOperatorModelPolicyError,
  OperatorModelPolicyError,
  runWithOperatorModelRequest,
} from "../agents/operator-model-policy.js";
import { captureGatewayToolOperatorAuthority } from "../agents/tools/gateway-caller-context.js";
import { captureOperatorToolGatewayAuthority } from "../gateway/operator-invocation-authority.js";
import { readOperatorToolGatewayAuthority } from "../gateway/server-plugin-in-process-dispatch.js";
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
    // Direct tools have an invocation owner even without a Gateway request scope.
    // Capture it before lazy loading; ordinary scoped requests still issue their source below.
    const direct = readOperatorToolGatewayAuthority();
    const invocation = direct
      ? captureCurrentSource(captureOperatorToolGatewayAuthority)
      : undefined;
    const assertInvocationCurrent = () =>
      captureCurrentSource(() => {
        // An admitted nested caller cannot replace the direct invocation's lifetime.
        direct?.signal.throwIfAborted();
        invocation?.assertCurrent();
      });
    assertInvocationCurrent();
    const source = captureCurrentSource(() =>
      invocation?.authority
        ? runWithOperatorModelRequest(invocation.authority, (authority) => ({
            authority,
            release: authority?.retain?.() ?? (() => {}),
          }))
        : captureRuntimeOperatorModelAuthority(),
    );
    if (source) {
      onAcquired({ release: source.release });
    }
    assertOperatorDecisionRuntimeAllowed(source?.authority);
    return await runWithOperatorModelRequest(source?.authority, async () => {
      const result = await run();
      assertInvocationCurrent();
      assertOperatorDecisionRuntimeAllowed(source?.authority);
      return result;
    });
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
