import { createHook } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

const root = process.env.F113_EVIDENCE;
if (root) {
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
    const report = process.report.getReport();
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
        libuv: report.libuv,
        sharedObjects: report.sharedObjects,
      }) + "\n",
    );
  };
  globalThis[Symbol.for("f113.capture")] = capture;
  capture("preload");
  process.on("exit", () => capture("exit"));
}
