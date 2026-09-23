/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { runSessionCommand } from "./command-process.js";

const DEFAULT_OUTPUT_LIMIT_CHARS = 16 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 5000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
  /** AbortSignal to cancel the command */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Optional maximum retained stdout/stderr characters per stream. */
  maxOutputChars?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  stdoutTruncatedChars?: number;
  stderrTruncatedChars?: number;
  outputLimitExceeded?: "stdout" | "stderr";
  code: number;
  killed: boolean;
}

type OutputCapture = {
  text: string;
  truncatedChars: number;
};
type OutputDecoder = ReturnType<typeof createWindowsOutputDecoder>;

function decodeCapturedOutput(decoder: OutputDecoder, chunk: Buffer | string): string {
  return Buffer.isBuffer(chunk) ? decoder.decode(chunk) : `${decoder.flush()}${chunk}`;
}

function clampMaxOutputChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_OUTPUT_LIMIT_CHARS;
  }
  return Math.max(1, Math.floor(value));
}

function appendCapturedOutput(
  current: OutputCapture,
  chunk: string,
  maxOutputChars: number,
  truncateTail: boolean,
): void {
  const combined = `${current.text}${chunk}`;
  const overflowChars = Math.max(0, combined.length - maxOutputChars);
  current.text =
    overflowChars === 0
      ? combined
      : truncateTail
        ? sliceUtf16Safe(combined, overflowChars)
        : sliceUtf16Safe(combined, 0, maxOutputChars);
  current.truncatedChars += combined.length - current.text.length;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
  command: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  const maxOutputChars = clampMaxOutputChars(options?.maxOutputChars);
  const truncateOutput = options?.maxOutputChars !== undefined;
  const output = {
    stdout: { text: "", truncatedChars: 0 },
    stderr: { text: "", truncatedChars: 0 },
  };
  const decoders = {
    stdout: createWindowsOutputDecoder({ preserveUtf8Bom: true }),
    stderr: createWindowsOutputDecoder({ preserveUtf8Bom: true }),
  };
  let outputLimitExceeded: "stdout" | "stderr" | undefined;
  const capture = (chunk: string, stream: "stdout" | "stderr"): boolean | void => {
    const before = output[stream].truncatedChars;
    appendCapturedOutput(output[stream], chunk, maxOutputChars, truncateOutput);
    if (!truncateOutput && output[stream].truncatedChars > before && !outputLimitExceeded) {
      outputLimitExceeded = stream;
      return false;
    }
  };
  const { outcome, killed } = await runSessionCommand([command, ...args], {
    cwd,
    signal: options?.signal,
    timeoutMs: options?.timeout,
    processTree: { mode: "graceful" },
    killGraceMs: FORCE_KILL_GRACE_MS,
    cancellationEndsAt: "exit",
    ignoreOutputErrors: true,
    onOutput: (chunk, stream) => capture(decodeCapturedOutput(decoders[stream], chunk), stream),
  });
  if (outcome === undefined) {
    return { stdout: "", stderr: "", code: 1, killed: true };
  }
  for (const stream of ["stdout", "stderr"] as const) {
    capture(decoders[stream].flush(), stream);
  }
  if (outputLimitExceeded) {
    appendCapturedOutput(
      output.stderr,
      `${output.stderr.text ? "\n" : ""}exec ${outputLimitExceeded} exceeded output limit ${maxOutputChars} chars`,
      maxOutputChars,
      true,
    );
  }
  const code =
    "result" in outcome ? (outcome.result.exitCode ?? (outcome.result.failed ? 1 : 0)) : 1;
  return {
    stdout: output.stdout.text,
    stderr: output.stderr.text,
    stdoutTruncatedChars: output.stdout.truncatedChars || undefined,
    stderrTruncatedChars: output.stderr.truncatedChars || undefined,
    outputLimitExceeded,
    code: outputLimitExceeded ? 1 : code,
    killed,
  };
}
