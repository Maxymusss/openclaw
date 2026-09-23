import { existsSync } from "node:fs";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { toErrorObject } from "../../../infra/errors.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS } from "../../../process/exec-spawn.js";
import {
  buildShellCommandInvocation,
  getBashShellConfig,
  getBashShellEnv,
} from "../../shell-utils.js";
import { runSessionCommand } from "../command-process.js";
import type { BashOperations } from "./bash-operations.js";

export function resolveBashTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (timeoutSeconds === undefined) {
    return undefined;
  }
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new Error("Invalid timeout: must be a positive finite number of seconds");
  }
  return resolveTimerTimeoutMs(timeoutSeconds * 1000, 1);
}

export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveBashTimeoutMs(timeout);
      const shellConfig = getBashShellConfig(options?.shellPath);
      const invocation = buildShellCommandInvocation(command, shellConfig);
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const shellEnv = env ?? getBashShellEnv(shellConfig.shell);
      try {
        const { outcome, timedOut } = await runSessionCommand(invocation.argv, {
          baseEnv: {},
          cwd,
          env: shellEnv,
          input: invocation.input,
          stdin: invocation.stdin,
          signal,
          timeoutMs,
          processTree: { mode: "force" },
          killGraceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
          cancellationEndsAt: "cleanup",
          onOutput: (chunk, stream) => {
            onData(chunk, stream);
          },
        });
        if (outcome === undefined) {
          throw new Error(signal?.aborted ? "aborted" : `timeout:${timeout}`);
        }
        if ("error" in outcome) {
          throw outcome.error;
        }
        const result = outcome.result;
        if (result.failed && result.exitCode === undefined && result.signal === undefined) {
          if (result instanceof Error) {
            throw result;
          }
          throw new Error(`Failed to launch shell: ${shellConfig.shell}`, { cause: result });
        }
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut || result.timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode: result.exitCode ?? (result.failed ? 1 : 0) };
      } catch (error) {
        throw toErrorObject(error, "Non-Error rejection");
      }
    },
  };
}
