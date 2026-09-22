import { trimLogTail } from "./restart-sentinel.js";
import {
  PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
  normalizeUpdatePostInstallDoctorWarnings,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import type { UpdateStepResult } from "./update-runner-types.js";

function isNormalProcessExit(step: {
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}): boolean {
  return (
    step.termination !== "timeout" &&
    step.termination !== "no-output-timeout" &&
    step.termination !== "signal" &&
    step.killed !== true &&
    (step.signal === undefined || step.signal === null)
  );
}

export function markPackagePostInstallDoctorAdvisory<
  T extends {
    exitCode: number | null;
    stderrTail?: string | null;
    signal?: NodeJS.Signals | null;
    killed?: boolean;
    termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
    advisory?: UpdateStepResult["advisory"];
  },
>(
  step: T,
  result: UpdatePostInstallDoctorResult | null,
): T & {
  advisory?: UpdateStepResult["advisory"];
  warnings?: UpdateStepResult["warnings"];
  failureFacts?: UpdateStepResult["failureFacts"];
} {
  if (step.exitCode !== 0 && result?.failureFacts?.length) {
    return { ...step, failureFacts: result.failureFacts };
  }
  if (
    !result ||
    result.status === "error" ||
    !isNormalProcessExit(step) ||
    !(
      (step.exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE &&
        result.status === "advisory") ||
      (step.exitCode === 0 && result.warnings?.length)
    )
  ) {
    return step;
  }
  const repairGuidance = "Run openclaw doctor --fix to finish deferred repairs.";
  const deferredWarnings =
    result.status === "advisory"
      ? normalizeUpdatePostInstallDoctorWarnings(result.advisory.details).map(
          (detail) => `${detail}\n${repairGuidance}`,
        )
      : [];
  const advisoryTail = [
    step.stderrTail,
    ...(result.status === "advisory" ? result.advisory.details : []),
    ...(result.warnings ?? []),
    PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
  ]
    .filter((line): line is string => Boolean(line?.trim()))
    .join("\n");
  return {
    ...step,
    warnings: [
      ...new Set([
        ...normalizeUpdatePostInstallDoctorWarnings(result.warnings ?? []),
        ...deferredWarnings,
      ]),
    ].slice(0, 32),
    advisory: {
      ...PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
      message: [
        ...(result.warnings ?? []),
        ...(result.status === "advisory" ? result.advisory.details : []),
        PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
        repairGuidance,
      ].join("\n"),
    },
    stderrTail: trimLogTail(advisoryTail) ?? step.stderrTail,
  };
}
