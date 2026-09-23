import type { AdmittedRunContext } from "../admitted-run-context.js";
import type { createAgentHarnessCompletionScope } from "../agent-harness-completion-scope.js";
import type { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

type AdmittedHostCapabilityTestFixture = Readonly<{
  admittedRunContext: AdmittedRunContext;
  hostCapabilities: ReturnType<typeof createAgentHarnessHostCapabilities>["capabilities"];
  agentHarnessCompletionScope?: ReturnType<typeof createAgentHarnessCompletionScope>;
  closeHost: () => void;
  closeAdmission: () => void;
}>;

/** Creates the same admitted authority and closure-bound host used by a real harness attempt. */
export async function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
  options: { nativeModelPolicySupport?: "exact" } = {},
): Promise<AdmittedHostCapabilityTestFixture> {
  const { createAgentHarnessCompletionScope } =
    await import("../agent-harness-completion-scope.js");
  const { createOperationalRunInstanceRef, prepareAgentRunAdmission } =
    await import("../admitted-run-context.js");
  const { createAgentHarnessHostCapabilities } = await import("./host-capability.js");
  const admission = prepareAgentRunAdmission({
    cfg: attempt.config ?? {},
    facts: {
      runId: attempt.runId,
      agentId: attempt.agentId ?? "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${attempt.runId}`);
  const host = createAgentHarnessHostCapabilities({
    attempt: { ...attempt, admittedRunContext },
    pluginId: "codex",
    nativeModelPolicySupport: options.nativeModelPolicySupport,
  });
  return {
    admittedRunContext,
    hostCapabilities: host.capabilities,
    ...(attempt.sessionKey
      ? {
          agentHarnessCompletionScope: createAgentHarnessCompletionScope({
            requesterSessionKey: attempt.sessionKey,
            requesterAgentId: attempt.agentId ?? "main",
          }),
        }
      : {}),
    closeHost: host.close,
    closeAdmission: admission.close,
  };
}
