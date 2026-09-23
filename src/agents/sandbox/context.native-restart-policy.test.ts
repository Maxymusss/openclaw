import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as executablePath from "../../infra/executable-path.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSandboxContextInternal } from "./context.js";
import {
  createNativeGeneration,
  createNativePipeline,
  type NativePipelineOptions,
} from "./context.native-custody.test-support.js";
import { readRegistry } from "./registry.js";

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: transport.spawn,
}));
vi.mock("../../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: async () => [],
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => undefined }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { label: "always", policy: { Name: "always" } },
  { label: "on-failure", policy: { Name: "on-failure" } },
  { label: "unless-stopped", policy: { Name: "unless-stopped" } },
  { label: "missing policy", policy: undefined },
  { label: "missing name", policy: {} },
  { label: "invalid name", policy: { Name: false } },
])("retains Podman custody for $label without removal", async ({ policy }) => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "native-restart-policy-" },
    async (state) => {
      const endpoint = `unix://${path.join(state.stateDir, "engine.sock")}`;
      vi.stubEnv("CONTAINER_HOST", endpoint);
      vi.stubEnv("CONTAINER_CONNECTION", "");
      vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockReturnValue(
        path.join(state.stateDir, "bin", "podman"),
      );
      const options: NativePipelineOptions = {};
      const h = createNativePipeline(
        { spawn: transport.spawn, stateDir: state.stateDir, endpoint },
        options,
      );
      const releases: Array<() => Promise<void>> = [];
      const { owner, custody } = await createNativeGeneration(releases);
      try {
        const context = await resolveSandboxContextInternal(
          {
            sessionKey: "agent:test:native",
            workspaceDir: path.join(state.stateDir, "workspace"),
            config: {
              agents: {
                defaults: {
                  sandbox: {
                    mode: "all",
                    backend: "podman",
                    scope: "shared",
                    workspaceAccess: "rw",
                    workspaceRoot: path.join(state.stateDir, "sandboxes"),
                    docker: { image: "fixture:local" },
                    prune: { idleHours: 0, maxAgeDays: 0 },
                  },
                },
              },
            },
          },
          custody,
        );
        expect(context?.backendId).toBe("podman");
        const before = await readRegistry();
        expect(before.entries).toHaveLength(1);
        options.restartPolicy = policy;
        await owner.release("completion");
        expect(() => owner.assertCleanupConfirmed()).toThrow(
          expect.objectContaining({
            name: "CommandProcessCleanupError",
            cause: expect.objectContaining({
              message: expect.stringContaining("construction policy"),
            }),
          }),
        );
        expect(() => owner.replace()).toThrow("confirmed cleanup");
        expect(h.commands.some((args) => args[0] === "rm")).toBe(false);
        await expect(readRegistry()).resolves.toEqual(before);
      } finally {
        try {
          for (const release of releases) {
            await release();
          }
        } finally {
          await closeOpenClawStateDatabaseAsync();
          closeOpenClawStateDatabaseForTest();
        }
      }
    },
  );
});
