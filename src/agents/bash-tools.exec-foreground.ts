import { resolveExecApprovalInitiatingSurfaceState } from "../infra/exec-approval-surface.js";
import type { ExecHost } from "../infra/exec-approvals.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type { ExecToolArgs } from "./bash-tools.exec-request-preparation.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { readNativeSandboxExecTarget } from "./sandbox/native-exec-binding.js";

/** The original host-issued restriction survives lazy loading and retained tool callbacks. */
export function captureForegroundExecPolicy(
  authority?: AdmittedRunOperatorAuthority,
  defaults?: ExecToolDefaults,
) {
  if (!authority) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  if (authority.executionPolicy !== "foreground-only") {
    return undefined;
  }
  return {
    assertCurrent: () => {
      authority.assertCurrent();
      readNativeSandboxExecTarget(defaults?.sandbox, defaults?.scopeKey);
    },
    assertApprovalRoute(params: { channel?: string; accountId?: string }) {
      authority.assertCurrent();
      if (resolveExecApprovalInitiatingSurfaceState(params).kind !== "enabled") {
        throw new Error(
          "This foreground turn cannot detach an approval to another surface. Use an available approval surface and send a new request.",
        );
      }
    },
    assertAllowed(params: ExecToolArgs, host: ExecHost, requestDefaults?: ExecToolDefaults) {
      authority.assertCurrent();
      if (
        params.background === true ||
        params.yieldMs !== undefined ||
        requestDefaults?.approvalFollowupMode !== undefined
      ) {
        throw new Error(
          "This turn permits foreground commands only. Omit background and yield options; approvals must finish within this turn.",
        );
      }
      const nativeSandbox =
        host === "sandbox" &&
        readNativeSandboxExecTarget(requestDefaults?.sandbox, requestDefaults?.scopeKey);
      if (
        process.platform === "win32" ||
        (!nativeSandbox && (host !== "gateway" || requestDefaults?.sandboxRequired))
      ) {
        throw new Error(
          "Foreground process cleanup is unavailable for this execution backend. Ask the operator to use a supported native sandbox or local POSIX execution environment; required sandbox policy remains in force.",
        );
      }
    },
  };
}
