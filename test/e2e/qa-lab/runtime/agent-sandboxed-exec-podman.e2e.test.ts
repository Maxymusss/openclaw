import { beforeAll, describe, expect } from "vitest";
// Install the retained transport delegate before importing sandbox owners.
import { registerNativeSandboxLifecycleTests } from "./agent-sandboxed-exec-native.test-support.js";

describe.runIf(process.env.CONTAINER_HOST !== undefined)(
  "Podman Unix service native foreground lifecycle",
  () => {
    beforeAll(() => {
      expect(process.env.CONTAINER_HOST).toMatch(/^unix:\/\/\/[^\s]+$/);
      expect(process.env.CONTAINER_CONNECTION).toBeUndefined();
    });
    registerNativeSandboxLifecycleTests("podman");
  },
);
