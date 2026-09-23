import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCiLaneReceipt } from "../../scripts/ci-lane-receipt.mjs";
import { canonicalAsciiJson } from "../../scripts/lib/canonical-json.mjs";

const SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);

function input() {
  return {
    captureUiProof: "false",
    ciShape: "default",
    compatibilityTarget: "false",
    event: "workflow_dispatch",
    historicalTargetTag: "",
    includeAndroid: "false",
    nodeRunnerBackend: "blacksmith",
    nodeVersion: "24.19.0",
    releaseCandidateRef: "",
    releaseGate: "false",
    releaseScope: "full",
    repository: "openclaw/openclaw",
    requestedRunnerBackend: "default",
    runAttempt: "1",
    runId: "123",
    runUrl: "https://github.com/openclaw/openclaw/actions/runs/123",
    runnerProfile: "blacksmith",
    targetSha: SHA,
    targetContextRef: "release/2026.9.22",
    workflowRef: "main",
    workflowSha: WORKFLOW_SHA,
  };
}

describe("CI lane receipt", () => {
  it("binds exact target, workflow, scope, and runner contracts", () => {
    const receipt = buildCiLaneReceipt(input());
    expect(receipt).toMatchObject({
      kind: "normal-ci",
      runAttempt: 1,
      runId: "123",
      schema: "openclaw.ci-lane-receipt/v1",
      contract: {
        releaseScope: "full",
        targetSha: SHA,
        workflowSha: WORKFLOW_SHA,
      },
    });
    expect(receipt.contractSha256).toBe(
      `sha256:${createHash("sha256").update(canonicalAsciiJson(receipt.contract)).digest("hex")}`,
    );
  });

  it.each([
    ["targetSha", "main"],
    ["workflowSha", "ABC"],
    ["releaseScope", "partial"],
    ["releaseGate", "0"],
    ["compatibilityTarget", "yes"],
  ])("rejects an invalid %s", (key, value) => {
    expect(() => buildCiLaneReceipt({ ...input(), [key]: value })).toThrow();
  });

  it("changes identity whenever an equivalence boundary changes", () => {
    const baseline = buildCiLaneReceipt(input()).contractSha256;
    for (const update of [
      { releaseScope: "npm-beta" },
      { targetSha: "c".repeat(40) },
      { workflowSha: "d".repeat(40) },
      { nodeRunnerBackend: "github" },
      { ciShape: "main" },
      { includeAndroid: "true" },
      { targetContextRef: "" },
    ]) {
      expect(buildCiLaneReceipt({ ...input(), ...update }).contractSha256).not.toBe(baseline);
    }
  });
});
