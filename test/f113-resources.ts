import { appendFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect } from "vitest";

afterAll(() => {
  const directory = process.env.F113_EVIDENCE;
  if (!directory) return;
  const snapshot = {
    phase: `afterAll:${expect.getState().testPath}`,
    resources: process.getActiveResourcesInfo(),
  };
  appendFileSync(
    path.join(directory, `resources-${process.pid}.jsonl`),
    JSON.stringify(snapshot) + "\n",
  );
  console.error("[f113-resource]", JSON.stringify(snapshot));
});
