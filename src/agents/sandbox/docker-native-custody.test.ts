import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as executablePath from "../../infra/executable-path.js";
import {
  bindNativeSandboxEngineTarget,
  captureNativeSandboxEngine,
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
} from "./container-engine.js";
import { commandResult, createNativeGeneration } from "./context.native-custody.test-support.js";
import { assertNativeSandboxCreatedContainer } from "./docker.js";

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: transport.spawn,
}));
const releases: Array<() => Promise<void>> = [];
const endpoint = "unix:///fixture/engine.sock";
const executable = path.join(os.tmpdir(), "fixture-container-engine");
function generation() {
  return createNativeGeneration(releases);
}
beforeEach(() => {
  vi.spyOn(executablePath, "resolveExecutableFromPathEnv").mockReturnValue(executable);
  transport.spawn.mockReset();
});
afterEach(async () => {
  for (const release of releases.splice(0)) {
    await release();
  }
  vi.restoreAllMocks();
});

describe("private native allocation construction policy", () => {
  const reservation = {
    containerName: "reserved-generation",
    sessionKey: "foreground-generation",
    createdAtMs: 1234,
    configHash: "captured-config",
  };
  const id = "c".repeat(64);

  it.each([DOCKER_SANDBOX_ENGINE, PODMAN_SANDBOX_ENGINE])(
    "accepts the exact $id construction shape on its captured endpoint",
    async (engine) => {
      const { custody } = await generation();
      const bound = bindNativeSandboxEngineTarget(captureNativeSandboxEngine(engine, custody), {
        key: "selected-engine",
        globalArgs: [engine.id === "docker" ? "--host" : "--url", endpoint],
      });
      transport.spawn.mockResolvedValue(
        commandResult(
          JSON.stringify({
            Id: id,
            Name:
              engine.id === "docker" ? `/${reservation.containerName}` : reservation.containerName,
            Namespace: "",
            Config: {
              Labels: {
                "openclaw.sandbox": "1",
                "openclaw.sessionKey": reservation.sessionKey,
                "openclaw.createdAtMs": String(reservation.createdAtMs),
                "openclaw.configHash": reservation.configHash,
              },
            },
            HostConfig: {
              PidMode: engine.id === "docker" ? "" : "private",
              RestartPolicy: { Name: "no" },
              AutoRemove: false,
            },
          }),
        ),
      );
      await assertNativeSandboxCreatedContainer(bound, id, reservation);
      expect(transport.spawn).toHaveBeenCalledExactlyOnceWith(
        [
          executable,
          engine.id === "docker" ? "--host" : "--url",
          endpoint,
          "inspect",
          "--format",
          "{{json .}}",
          id,
        ],
        expect.anything(),
      );
    },
  );

  it.each([
    { changed: "ID", top: { Id: "d".repeat(64) } },
    { changed: "name", top: { Name: "/other-generation" } },
    { changed: "owner", labels: { "openclaw.sessionKey": "other-owner" } },
    { changed: "creation receipt", labels: { "openclaw.createdAtMs": "5678" } },
    { changed: "configuration", labels: { "openclaw.configHash": "other-config" } },
    { changed: "host PID namespace", host: { PidMode: "host" } },
    { changed: "joined PID namespace", host: { PidMode: "container:other" } },
    { changed: "restart policy", host: { RestartPolicy: { Name: "always" } } },
    { changed: "automatic removal", host: { AutoRemove: true } },
    { changed: "missing host policy", top: { HostConfig: null } },
  ])(
    "refuses a mismatched $changed without addressing a reusable name",
    async ({ top, labels, host }) => {
      const { custody } = await generation();
      const bound = bindNativeSandboxEngineTarget(
        captureNativeSandboxEngine(DOCKER_SANDBOX_ENGINE, custody),
        {
          key: "selected-engine",
          globalArgs: ["--host", endpoint],
        },
      );
      const inspected = {
        Id: id,
        Name: `/${reservation.containerName}`,
        Config: {
          Labels: {
            "openclaw.sandbox": "1",
            "openclaw.sessionKey": reservation.sessionKey,
            "openclaw.createdAtMs": String(reservation.createdAtMs),
            "openclaw.configHash": reservation.configHash,
            ...labels,
          },
        },
        HostConfig: { PidMode: "", RestartPolicy: { Name: "no" }, AutoRemove: false, ...host },
        ...top,
      };
      transport.spawn.mockResolvedValue(commandResult(JSON.stringify(inspected)));
      await expect(assertNativeSandboxCreatedContainer(bound, id, reservation)).rejects.toThrow(
        "reserved owner or construction policy",
      );
      expect(transport.spawn).toHaveBeenCalledExactlyOnceWith(
        [executable, "--host", endpoint, "inspect", "--format", "{{json .}}", id],
        expect.anything(),
      );
    },
  );
});
