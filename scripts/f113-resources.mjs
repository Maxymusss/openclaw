import { createHook } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

const root = process.env.F113_EVIDENCE;
if (root) {
  const require = createRequire(import.meta.url);
  mkdirSync(root, { recursive: true });
  const output = path.join(root, `resources-${process.pid}-${threadId}.jsonl`);
  const resources = new Map();
  const tracked = new Set([
    "WORKER",
    "MESSAGEPORT",
    "TCPWRAP",
    "TCPSERVERWRAP",
    "Timeout",
    "FSEVENTWRAP",
  ]);
  createHook({
    init(id, type, trigger) {
      if (tracked.has(type)) resources.set(id, { id, type, trigger, stack: new Error().stack });
    },
    destroy(id) {
      resources.delete(id);
    },
  }).enable();
  const capture = (phase) => {
    appendFileSync(
      output,
      JSON.stringify({
        phase,
        pid: process.pid,
        threadId,
        isMainThread,
        argv: process.argv,
        resources: process.getActiveResourcesInfo(),
        tracked: [...resources.values()],
        nativeAddons: Object.keys(require.cache).filter((file) => file.endsWith(".node")),
      }) + "\n",
    );
  };
  globalThis[Symbol.for("f113.capture")] = capture;
  capture("preload");
  process.on("exit", () => capture("exit"));
}
