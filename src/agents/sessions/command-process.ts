import { releaseChildProcessOutputAfterExit } from "../../process/child-process.js";
import { waitForCommandSpawn } from "../../process/exec-spawn.js";
import { createCommandTerminationController } from "../../process/exec-termination.js";
import { spawnCommand } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";

/** Session commands retain late startup cleanup after returning cancellation to their caller. */
export async function runSessionCommand(
  argv: string[],
  options: {
    cwd: string;
    baseEnv?: NodeJS.ProcessEnv;
    env?: NodeJS.ProcessEnv;
    input?: string;
    stdin?: "ignore" | "pipe";
    signal?: AbortSignal;
    timeoutMs?: number;
    processTree: { mode: "graceful" } | { mode: "force" };
    killGraceMs: number;
    cancellationEndsAt: "exit" | "cleanup";
    onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => boolean | void;
    ignoreOutputErrors?: boolean;
  },
) {
  const cancelController = new AbortController();
  const startupCanceled = createDeferredCore<undefined>();
  let waitingForSpawn = true;
  let acceptingOutput = true;
  let killed = false;
  let timedOut = false;
  let terminationStarted = false;
  let termination: ReturnType<typeof createCommandTerminationController> | undefined;
  const terminate = () => {
    killed = true;
    if (termination) {
      if (!terminationStarted) {
        terminationStarted = true;
        if (!termination.terminate()) {
          cancelController.abort();
        }
      }
    } else {
      cancelController.abort();
    }
    if (waitingForSpawn) {
      startupCanceled.resolve(undefined);
    }
  };
  options.signal?.addEventListener("abort", terminate, { once: true });
  const timeout =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs)
      : undefined;
  const disarmCancellation = () => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", terminate);
  };
  try {
    const child = spawnCommand(argv, {
      ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.input === undefined ? {} : { input: options.input }),
      buffer: false,
      cancelSignal: cancelController.signal,
      cwd: options.cwd,
      detached: process.platform !== "win32",
      forceKillAfterDelay: options.killGraceMs,
      reject: false,
      stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    });
    type CommandOutcome = { result: Awaited<typeof child> } | { error: unknown };
    const completion = (async (): Promise<CommandOutcome> => {
      if (child.pid === undefined) {
        await waitForCommandSpawn(child);
      }
      waitingForSpawn = false;
      const releaseOutput = releaseChildProcessOutputAfterExit(child.nodeChildProcess);
      let childExited = false;
      let commandSettled = false;
      child.nodeChildProcess.once("exit", () => {
        childExited = true;
      });
      termination = createCommandTerminationController({
        child: child.nodeChildProcess,
        cancelController,
        baseEnv: options.baseEnv,
        env: options.env,
        processTree: options.processTree,
        killGraceMs: options.killGraceMs,
        isChildExited: () => childExited,
        isCommandSettled: () => commandSettled,
      });
      for (const stream of ["stdout", "stderr"] as const) {
        if (options.ignoreOutputErrors) {
          // Pipe errors do not replace the command's termination result.
          child[stream]?.on("error", () => {});
        }
        child[stream]?.on("data", (chunk: Buffer) => {
          if (acceptingOutput && options.onOutput(chunk, stream) === false) {
            terminate();
          }
        });
      }
      if (killed) {
        terminate();
      }
      try {
        return { result: await child };
      } catch (error) {
        return { error };
      } finally {
        commandSettled = true;
        if (options.cancellationEndsAt === "exit") {
          disarmCancellation();
        }
        try {
          await termination.settle();
        } finally {
          releaseOutput();
        }
      }
    })();
    if (options.signal?.aborted) {
      terminate();
    }
    const outcome = await Promise.race([completion, startupCanceled.promise]);
    return { outcome, killed, timedOut };
  } finally {
    acceptingOutput = false;
    disarmCancellation();
  }
}
