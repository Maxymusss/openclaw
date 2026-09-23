#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalAsciiJson } from "./lib/canonical-json.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const RELEASE_SCOPES = new Set(["full", "npm-beta", "npm-stable"]);

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function sha(value, label) {
  const normalized = required(value, label);
  if (!SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a full lowercase commit SHA`);
  }
  return normalized;
}

function runId(value, label) {
  const normalized = required(value, label);
  if (!RUN_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function booleanString(value, label) {
  const normalized = required(value, label);
  if (normalized !== "true" && normalized !== "false") {
    throw new Error(`${label} must be true or false`);
  }
  return normalized;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalAsciiJson(value)).digest("hex")}`;
}

export function buildCiLaneReceipt(input) {
  const releaseScope = required(input.releaseScope, "release scope");
  if (!RELEASE_SCOPES.has(releaseScope)) {
    throw new Error(`unsupported release scope: ${releaseScope}`);
  }
  const contract = {
    captureUiProof: booleanString(input.captureUiProof, "capture UI proof"),
    ciShape: required(input.ciShape, "CI shape"),
    compatibilityTarget: booleanString(input.compatibilityTarget, "compatibility target"),
    historicalTargetTag: String(input.historicalTargetTag ?? ""),
    includeAndroid: booleanString(input.includeAndroid, "include Android"),
    nodeRunnerBackend: required(input.nodeRunnerBackend, "Node runner backend"),
    nodeVersion: required(input.nodeVersion, "Node version"),
    releaseCandidateRef: String(input.releaseCandidateRef ?? ""),
    releaseGate: booleanString(input.releaseGate, "release gate"),
    releaseScope,
    requestedRunnerBackend: required(input.requestedRunnerBackend, "requested runner backend"),
    runnerProfile: required(input.runnerProfile, "runner profile"),
    targetSha: sha(input.targetSha, "target SHA"),
    targetContextRef: String(input.targetContextRef ?? ""),
    workflowRef: required(input.workflowRef, "workflow ref"),
    workflowSha: sha(input.workflowSha, "workflow SHA"),
  };
  return {
    contract,
    contractSha256: digest(contract),
    event: required(input.event, "event"),
    kind: "normal-ci",
    repository: required(input.repository, "repository"),
    runAttempt: Number(runId(input.runAttempt, "run attempt")),
    runId: runId(input.runId, "run ID"),
    runUrl: required(input.runUrl, "run URL"),
    schema: "openclaw.ci-lane-receipt/v1",
  };
}

export function ciLaneReceiptFromEnvironment(env = process.env) {
  return buildCiLaneReceipt({
    captureUiProof: env.CAPTURE_UI_PROOF,
    ciShape: env.CI_SHAPE,
    compatibilityTarget: env.COMPATIBILITY_TARGET,
    event: env.GITHUB_EVENT_NAME,
    historicalTargetTag: env.HISTORICAL_TARGET_TAG,
    includeAndroid: env.INCLUDE_ANDROID,
    nodeRunnerBackend: env.NODE_RUNNER_BACKEND,
    nodeVersion: env.NODE_VERSION,
    releaseCandidateRef: env.RELEASE_CANDIDATE_REF,
    releaseGate: env.RELEASE_GATE,
    releaseScope: env.RELEASE_SCOPE,
    repository: env.GITHUB_REPOSITORY,
    requestedRunnerBackend: env.REQUESTED_RUNNER_BACKEND,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    runId: env.GITHUB_RUN_ID,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    runnerProfile: env.RUNNER_PROFILE,
    targetSha: env.TARGET_SHA,
    targetContextRef: env.TARGET_CONTEXT_REF,
    workflowRef: env.GITHUB_REF_NAME,
    workflowSha: env.GITHUB_SHA,
  });
}

if (process.argv[1]?.endsWith("ci-lane-receipt.mjs")) {
  try {
    const output = required(process.env.CI_LANE_RECEIPT_PATH, "receipt output path");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, canonicalAsciiJson(ciLaneReceiptFromEnvironment()), { flag: "wx" });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
