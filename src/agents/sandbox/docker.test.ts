// Docker image tests cover sandbox image inspection and actionable setup errors
// without invoking a real Docker daemon.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

type SpawnCall = {
  command: string;
  args: string[];
};

type SpawnCallOptions = {
  maxBuffer?: number;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  imageExists: true,
  inspectError: "",
  infoAvailable: { docker: false, podman: false },
  podmanConnections: "[]\n",
  podmanClientVersion: "podman version 5.8.2\n",
  podmanClientVersionCode: 0,
  podmanInfo: "true\tfalse\t\t5.0.0\n",
  podmanMachines: "[]\n",
  lastOptions: undefined as SpawnCallOptions | undefined,
  executionError: undefined as Error | undefined,
  transportFailure: false,
  transportExitCode: 0,
  plainExitWithoutStderr: false,
  commandResult: undefined as { code: number; stdout: string; stderr: string } | undefined,
}));

async function spawnDockerProcess(commandAndArgs: string[], options?: SpawnCallOptions) {
  const [command = "", ...args] = commandAndArgs;
  spawnState.calls.push({ command, args });
  spawnState.lastOptions = options;
  if (spawnState.executionError) {
    throw spawnState.executionError;
  }
  if (spawnState.transportFailure) {
    return Object.assign(new Error("docker stream failed"), {
      cause: new Error("docker stream failed"),
      failed: true,
      isCanceled: false,
      exitCode: spawnState.transportExitCode,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  }
  if (spawnState.plainExitWithoutStderr) {
    return {
      failed: true,
      isCanceled: false,
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }

  if (spawnState.commandResult) {
    const { code, stdout, stderr } = spawnState.commandResult;
    return {
      failed: code !== 0,
      isCanceled: false,
      exitCode: code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    };
  }

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (command === "podman" && args[0] === "--version") {
    stdout = spawnState.podmanClientVersion;
    code = spawnState.podmanClientVersionCode;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
  } else if (command === "podman" && args[0] === "machine") {
    stdout = spawnState.podmanMachines;
  } else if (args[0] === "info") {
    code = spawnState.infoAvailable[command as "docker" | "podman"] ? 0 : 1;
    if (code === 0 && command === "podman" && args.includes("--format")) {
      stdout = spawnState.podmanInfo;
    }
    stderr = code === 0 ? "" : `${command} unavailable`;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = spawnState.imageExists ? 0 : 1;
    stderr = spawnState.imageExists
      ? ""
      : spawnState.inspectError || `Error response from daemon: No such image: ${args[2]}`;
  } else if (args[0] !== "pull" && args[0] !== "tag") {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let dockerSandboxEngine: typeof import("./docker.js").DOCKER_SANDBOX_ENGINE;
let ensureContainerImage: typeof import("./docker.js").ensureContainerImage;
let execDockerRaw: typeof import("./docker.js").execDockerRaw;
let execContainerRaw: typeof import("./docker.js").execContainerRaw;
let podmanSandboxEngine: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;
let resolvePodmanSandboxRuntimeInfo: typeof import("./docker.js").resolvePodmanSandboxRuntimeInfo;
let validateSandboxContainerEngineTarget: typeof import("./docker.js").validateSandboxContainerEngineTarget;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  const dockerModule = await import("./docker.js");
  ({ ensureContainerImage, execDockerRaw, execContainerRaw } = dockerModule);
  dockerSandboxEngine = dockerModule.DOCKER_SANDBOX_ENGINE;
  resolvePodmanSandboxRuntimeInfo = dockerModule.resolvePodmanSandboxRuntimeInfo;
  validateSandboxContainerEngineTarget = dockerModule.validateSandboxContainerEngineTarget;
  podmanSandboxEngine = dockerModule.PODMAN_SANDBOX_ENGINE;
});

beforeEach(() => {
  // Hoisted fault state survives module resets and must not reach the next case.
  spawnState.calls.length = 0;
  spawnState.imageExists = true;
  spawnState.inspectError = "";
  spawnState.infoAvailable.docker = false;
  spawnState.infoAvailable.podman = false;
  spawnState.podmanConnections = "[]\n";
  spawnState.podmanClientVersion = "podman version 5.8.2\n";
  spawnState.podmanClientVersionCode = 0;
  spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
  spawnState.podmanMachines = "[]\n";
  spawnState.lastOptions = undefined;
  spawnState.executionError = undefined;
  spawnState.transportFailure = false;
  spawnState.transportExitCode = 0;
  spawnState.plainExitWithoutStderr = false;
  spawnState.commandResult = undefined;
});

describe("resolvePodmanSandboxRuntimeInfo", () => {
  beforeEach(() => {
    spawnState.infoAvailable.podman = true;
  });

  it("rejects an arbitrary remote Podman connection", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("allows Podman Machine connections", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
        Identity: "/tmp/podman-machine-default",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-default",
        Running: true,
        IdentityPath: "/tmp/podman-machine-default",
        Port: 60000,
        RemoteUsername: "core",
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: true,
      rootless: true,
      version: "5.0.0",
      target: {
        key: expect.stringMatching(/^machine:[a-f0-9]{32}$/u),
        globalArgs: [
          "--url",
          "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock",
          "--identity",
          "/tmp/podman-machine-default",
        ],
      },
    });
  });

  it("allows rootful Podman Machine connections", async () => {
    spawnState.podmanInfo = "false\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default-root",
        URI: "ssh://root@127.0.0.1:60000/run/podman/podman.sock",
        Identity: "/tmp/podman-machine-default",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-default",
        Running: true,
        IdentityPath: "/tmp/podman-machine-default",
        Port: 60000,
        RemoteUsername: "core",
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
      machine: true,
      rootless: false,
      target: {
        globalArgs: [
          "--url",
          "ssh://root@127.0.0.1:60000/run/podman/podman.sock",
          "--identity",
          "/tmp/podman-machine-default",
        ],
      },
    });
  });

  it("rejects an unknown configured remote connection", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
        Default: true,
      },
    ]);

    await withEnvAsync({ CONTAINER_CONNECTION: "missing", CONTAINER_HOST: undefined }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(/could not be identified/u);
    });
  });

  it.each(
    [
      { client: "4.3.0", server: "5.8.2", namedFirst: false },
      { client: "4.7.2", server: "5.8.2", namedFirst: false },
      { client: "4.8.0", server: "4.3.0", namedFirst: true },
      { client: "5.8.2", server: "4.3.0", namedFirst: true },
    ].flatMap((version) =>
      [
        { host: "unix:///tmp/host.sock", connection: "named" },
        { host: "", connection: "named" },
        { host: "  ", connection: "named" },
        { host: "", connection: "" },
        { host: "", connection: undefined },
      ].map((env) => ({
        client: version.client,
        server: version.server,
        namedFirst: version.namedFirst,
        host: env.host,
        connection: env.connection,
      })),
    ),
  )(
    "uses client $client precedence with server $server, HOST '$host', CONNECTION '$connection'",
    async ({ client, server, namedFirst, host, connection }) => {
      spawnState.podmanClientVersion = `podman version ${client}\n`;
      spawnState.podmanInfo = `true\ttrue\t/tmp/fallback.sock\t${server}\n`;
      spawnState.podmanConnections = JSON.stringify([
        { Name: "named", URI: "unix:///tmp/named.sock" },
        { Name: "default", URI: "unix:///tmp/default.sock", Default: true },
      ]);
      await withEnvAsync({ CONTAINER_HOST: host, CONTAINER_CONNECTION: connection }, async () => {
        if (namedFirst || host.startsWith("unix://")) {
          const expectedUri = namedFirst
            ? connection
              ? "unix:///tmp/named.sock"
              : "unix:///tmp/default.sock"
            : host;
          await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
            version: server,
            target: { globalArgs: ["--url", expectedUri] },
          });
        } else {
          await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
            /could not be identified/u,
          );
        }
        expect(spawnState.calls.filter((call) => call.args[0] === "--version")).toEqual([
          { command: "podman", args: ["--version"] },
        ]);
      });
    },
  );

  it.each([
    { host: undefined, connection: undefined, uri: "unix:///tmp/default.sock" },
    { host: undefined, connection: "", uri: "unix:///tmp/default.sock" },
    { host: undefined, connection: "named", uri: "unix:///tmp/named.sock" },
    { host: undefined, connection: " named ", uri: "unix:///tmp/spaced-name.sock" },
    { host: undefined, connection: "  ", uri: "unix:///tmp/blank-name.sock" },
    { host: "unix:///tmp/host.sock", connection: undefined, uri: "unix:///tmp/host.sock" },
    { host: "unix:///tmp/host.sock", connection: "", uri: "unix:///tmp/host.sock" },
    { host: "unix:///tmp/host socket ", connection: undefined, uri: "unix:///tmp/host socket " },
  ])(
    "preserves raw HOST '$host' and CONNECTION '$connection' without probing the client",
    async ({ host, connection, uri }) => {
      spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t5.8.2\n";
      spawnState.podmanClientVersionCode = 1;
      spawnState.podmanConnections = JSON.stringify([
        { Name: "named", URI: "unix:///tmp/named.sock" },
        { Name: " named ", URI: "unix:///tmp/spaced-name.sock" },
        { Name: "  ", URI: "unix:///tmp/blank-name.sock" },
        { Name: "default", URI: "unix:///tmp/default.sock", Default: true },
      ]);
      await withEnvAsync({ CONTAINER_HOST: host, CONTAINER_CONNECTION: connection }, async () => {
        await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
          target: { globalArgs: ["--url", uri] },
        });
        expect(spawnState.calls.some((call) => call.args[0] === "--version")).toBe(false);
      });
    },
  );

  it.each([
    { host: "  ", connection: undefined },
    { host: undefined, connection: " named " },
    { host: "unix:///tmp/host.sock", connection: "missing" },
  ])(
    "does not replace an invalid raw HOST '$host' or CONNECTION '$connection' with the default",
    async ({ host, connection }) => {
      spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t5.8.2\n";
      spawnState.podmanConnections = JSON.stringify([
        { Name: "named", URI: "unix:///tmp/named.sock", Default: true },
      ]);
      await withEnvAsync({ CONTAINER_HOST: host, CONTAINER_CONNECTION: connection }, async () => {
        await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(/could not be identified/u);
      });
    },
  );

  it.each([
    { version: "podman version 5.8.2\n", code: 1 },
    { version: "unrecognized client version\n", code: 0 },
  ])(
    "rejects ambiguous selection when the client version probe fails: $version / $code",
    async ({ version, code }) => {
      spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t5.8.2\n";
      spawnState.podmanClientVersion = version;
      spawnState.podmanClientVersionCode = code;
      await withEnvAsync({ CONTAINER_HOST: "", CONTAINER_CONNECTION: "named" }, async () => {
        await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
          /Podman client connection selection/u,
        );
        expect(spawnState.calls.map((call) => call.args[0])).toEqual([
          "info",
          "system",
          "--version",
        ]);
      });
    },
  );

  it.each([undefined, ""])(
    "does not redirect a selected connection with URI %s to the reported socket",
    async (uri) => {
      spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t5.8.2\n";
      spawnState.podmanConnections = JSON.stringify([{ Name: "named", URI: uri, Default: true }]);
      for (const connection of ["named", undefined]) {
        await withEnvAsync(
          { CONTAINER_HOST: undefined, CONTAINER_CONNECTION: connection },
          async () => {
            await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
              /could not be identified/u,
            );
          },
        );
      }
    },
  );

  describe("Podman Machine identity selection", () => {
    const machineUri = "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock";
    const machineKey = "/tmp/machine key ";
    beforeEach(() => {
      spawnState.podmanInfo = "true\ttrue\t\t5.8.2\n";
      spawnState.podmanMachines = JSON.stringify([
        {
          Name: "machine",
          Running: true,
          IdentityPath: machineKey,
          Port: 60000,
          RemoteUsername: "core",
        },
      ]);
    });

    it.each([
      { identity: machineKey, sshKey: "/tmp/unrelated-key", connection: "machine" },
      { identity: machineKey, sshKey: "/tmp/unrelated-key", connection: undefined },
      { identity: "", sshKey: machineKey, connection: "machine" },
      { identity: undefined, sshKey: machineKey, connection: undefined },
    ])(
      "uses saved identity '$identity' then raw SSHKEY for CONNECTION '$connection'",
      async ({ identity, sshKey, connection }) => {
        spawnState.podmanConnections = JSON.stringify([
          { Name: "machine", URI: machineUri, Identity: identity, Default: true },
        ]);
        await withEnvAsync(
          { CONTAINER_HOST: undefined, CONTAINER_CONNECTION: connection, CONTAINER_SSHKEY: sshKey },
          async () => {
            await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
              target: { globalArgs: ["--url", machineUri, "--identity", machineKey] },
            });
          },
        );
      },
    );

    it.each([machineKey, "", undefined, "/tmp/wrong-key"])(
      "does not borrow saved credentials for explicit HOST with SSHKEY '%s'",
      async (sshKey) => {
        spawnState.podmanConnections = JSON.stringify([
          { Name: "unrelated", URI: machineUri, Identity: "/tmp/saved-key", Default: true },
        ]);
        await withEnvAsync(
          { CONTAINER_HOST: machineUri, CONTAINER_CONNECTION: undefined, CONTAINER_SSHKEY: sshKey },
          async () => {
            if (sshKey === "/tmp/wrong-key") {
              await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
                /active Podman connection is remote/u,
              );
            } else {
              await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
                target: {
                  globalArgs: ["--url", machineUri, ...(sshKey ? ["--identity", sshKey] : [])],
                },
              });
            }
          },
        );
      },
    );

    it.each([
      {
        user: "root",
        hostname: "127.0.0.1",
        port: 60000,
        key: machineKey,
        running: true,
        allowed: true,
      },
      {
        user: "root",
        hostname: "127.0.0.1",
        port: 60000,
        key: "/tmp/wrong-key",
        running: true,
        allowed: false,
      },
      {
        user: "other",
        hostname: "127.0.0.1",
        port: 60000,
        key: machineKey,
        running: true,
        allowed: false,
      },
      {
        user: "root",
        hostname: "192.0.2.1",
        port: 60000,
        key: machineKey,
        running: true,
        allowed: false,
      },
      {
        user: "root",
        hostname: "127.0.0.1",
        port: 60001,
        key: machineKey,
        running: true,
        allowed: false,
      },
      {
        user: "root",
        hostname: "127.0.0.1",
        port: 60000,
        key: machineKey,
        running: false,
        allowed: false,
      },
    ])(
      "validates rootful HOST against running machine facts: $user / $hostname / $port / $key / $running",
      async ({ user, hostname, port, key, running, allowed }) => {
        const uri = `ssh://${user}@${hostname}:${port}/run/podman/podman.sock`;
        spawnState.podmanInfo = "false\ttrue\t\t5.8.2\n";
        spawnState.podmanConnections = JSON.stringify([
          { Name: "machine-root", URI: uri, Identity: "/tmp/saved-key", Default: true },
        ]);
        spawnState.podmanMachines = JSON.stringify([
          {
            Name: "machine",
            Running: running,
            IdentityPath: machineKey,
            Port: 60000,
            RemoteUsername: "core",
          },
        ]);
        await withEnvAsync(
          { CONTAINER_HOST: uri, CONTAINER_CONNECTION: undefined, CONTAINER_SSHKEY: key },
          async () => {
            if (allowed) {
              await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
                machine: true,
                rootless: false,
                target: { globalArgs: ["--url", uri, "--identity", machineKey] },
              });
            } else {
              await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
                /active Podman connection is remote/u,
              );
            }
          },
        );
      },
    );
  });

  it("uses Podman's local Unix fallback when no connection is configured", async () => {
    spawnState.podmanInfo = "true\ttrue\t/run/user/1000/podman/podman.sock\t5.0.0\n";

    await withEnvAsync({ CONTAINER_CONNECTION: undefined, CONTAINER_HOST: undefined }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
        machine: false,
        rootless: true,
        version: "5.0.0",
        target: {
          key: expect.stringMatching(/^socket:[a-f0-9]{32}$/u),
          globalArgs: ["--url", "unix:///run/user/1000/podman/podman.sock"],
        },
      });
    });
  });

  it("revalidates the active Podman connection on every resolution", async () => {
    spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    });

    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("ignores a saved remote default while the CLI uses its local engine", async () => {
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "saved-remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    });
    expect(spawnState.calls.some((call) => call.args[0] === "system")).toBe(false);
    expect(spawnState.calls.some((call) => call.args[0] === "--version")).toBe(false);
  });

  it("rejects a different allowed Podman Machine after a runtime target is recorded", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-first",
        URI: "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock",
        Identity: "/tmp/first-machine-key",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-first",
        Running: true,
        IdentityPath: "/tmp/first-machine-key",
        Port: 60001,
        RemoteUsername: "core",
      },
    ]);
    const first = await resolvePodmanSandboxRuntimeInfo();

    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-second",
        URI: "ssh://core@127.0.0.1:60002/run/user/501/podman/podman.sock",
        Identity: "/tmp/second-machine-key",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-second",
        Running: true,
        IdentityPath: "/tmp/second-machine-key",
        Port: 60002,
        RemoteUsername: "core",
      },
    ]);

    await expect(
      validateSandboxContainerEngineTarget(podmanSandboxEngine, first.target),
    ).rejects.toThrow(/active Podman connection changed/u);
  });
});

describe("ensureContainerImage", () => {
  it("returns when the configured image already exists", async () => {
    await ensureContainerImage(dockerSandboxEngine, DEFAULT_SANDBOX_IMAGE);

    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("does not satisfy the missing default sandbox image by tagging plain Debian", async () => {
    // The default image carries Python/helper contracts; tagging a base distro
    // would pass image inspection but fail sandbox file operations later.
    spawnState.imageExists = false;

    let err: unknown;
    try {
      await ensureContainerImage(dockerSandboxEngine, DEFAULT_SANDBOX_IMAGE);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `Sandbox image not found: ${DEFAULT_SANDBOX_IMAGE}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("gives Podman users a Podman build command for the missing default image", async () => {
    spawnState.imageExists = false;

    await expect(ensureContainerImage(podmanSandboxEngine, DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      `podman build -t ${DEFAULT_SANDBOX_IMAGE} -f scripts/docker/sandbox/Dockerfile .`,
    );

    expect(spawnState.calls).toEqual([
      {
        command: "podman",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("throws when the Docker daemon is unavailable during image inspection", async () => {
    spawnState.imageExists = false;
    spawnState.inspectError =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

    await expect(ensureContainerImage(dockerSandboxEngine, DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      "Docker daemon is not available",
    );

    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("preserves the Docker error for other image inspection failures", async () => {
    spawnState.imageExists = false;
    spawnState.inspectError = "permission denied";

    await expect(ensureContainerImage(dockerSandboxEngine, DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      "Failed to inspect sandbox image: permission denied",
    );
  });

  it("preserves the Docker error for a missing custom image", async () => {
    spawnState.imageExists = false;

    await expect(
      ensureContainerImage(dockerSandboxEngine, "example/custom:latest"),
    ).rejects.toThrow("Sandbox image not found: example/custom:latest. Build or pull it first.");
  });
});

describe("Podman init dependency diagnostics", () => {
  const lookupError =
    'Error: lookup init binary: exec: "catatonit": executable file not found in $PATH';

  it.each([
    { name: "missing default helper", stderr: lookupError, globalArgs: [] },
    {
      name: "missing configured init on the engine host",
      stderr:
        "Error: container-init binary not found on the host: stat /opt/container-init: no such file or directory",
      globalArgs: ["--url", "unix:///run/user/1000/podman/podman.sock"],
    },
  ])(
    "explains $name without losing engine evidence or retrying",
    async ({ stderr, globalArgs }) => {
      const stdout = "engine diagnostic output\n";
      spawnState.commandResult = { code: 125, stdout, stderr: `${stderr}\n` };
      const args = [
        "create",
        "--init",
        "--env",
        "TOKEN=synthetic-private-value",
        DEFAULT_SANDBOX_IMAGE,
      ];

      const error = await execContainerRaw({ ...podmanSandboxEngine, globalArgs }, args).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        code: 125,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(`${stderr}\n`),
      });
      expect(error).toHaveProperty("message", expect.stringContaining(stderr));
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("Install catatonit on the Podman engine host"),
      );
      expect(error).toHaveProperty("message", expect.stringContaining("init_path"));
      expect(error).toHaveProperty("message", expect.stringContaining("helper_binaries_dir"));
      expect(error).toHaveProperty(
        "message",
        expect.not.stringContaining("synthetic-private-value"),
      );
      expect(spawnState.calls).toEqual([{ command: "podman", args: [...globalArgs, ...args] }]);
    },
  );

  it.each([
    { engine: "docker", args: ["create", "--init"], stderr: lookupError },
    { engine: "podman", args: ["exec", "sandbox", "catatonit"], stderr: lookupError },
    { engine: "podman", args: ["start", "sandbox"], stderr: lookupError },
    { engine: "podman", args: ["create", "--init"], stderr: "Error: permission denied" },
    {
      engine: "podman",
      args: ["create", "--init"],
      stderr:
        'Error: conflict with mount added by --init to "/run/podman-init": duplicate mount destination',
    },
    {
      engine: "podman",
      args: ["create", "--init"],
      stderr: 'Error: image "catatonit" not found',
    },
  ] as const)("preserves unrelated $engine $args errors", async ({ engine, args, stderr }) => {
    spawnState.commandResult = { code: 125, stdout: "", stderr };

    await expect(
      execContainerRaw(engine === "podman" ? podmanSandboxEngine : dockerSandboxEngine, [...args]),
    ).rejects.toMatchObject({ message: stderr, code: 125, stderr: Buffer.from(stderr) });
    expect(spawnState.calls).toHaveLength(1);
  });

  it("returns raw init diagnostics when failure is allowed", async () => {
    spawnState.commandResult = { code: 125, stdout: "", stderr: lookupError };

    await expect(
      execContainerRaw(podmanSandboxEngine, ["create", "--init"], { allowFailure: true }),
    ).resolves.toEqual({ code: 125, stdout: Buffer.alloc(0), stderr: Buffer.from(lookupError) });
  });

  it("does not reject successful creates because of stderr text", async () => {
    spawnState.commandResult = { code: 0, stdout: "container-id", stderr: lookupError };

    await expect(execContainerRaw(podmanSandboxEngine, ["create", "--init"])).resolves.toEqual({
      code: 0,
      stdout: Buffer.from("container-id"),
      stderr: Buffer.from(lookupError),
    });
  });
});

describe("execDockerRaw", () => {
  it("preserves canonical wrapper execution errors", async () => {
    spawnState.executionError = new Error("docker execution failed");

    await expect(
      execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE], { allowFailure: true }),
    ).rejects.toThrow("docker execution failed");
  });

  it("applies the sandbox output cap explicitly", async () => {
    await execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE]);

    expect(spawnState.lastOptions?.maxBuffer).toBe(SANDBOX_COMMAND_MAX_BUFFER_BYTES);
  });

  it("rejects transport failures even when Docker exits zero", async () => {
    spawnState.transportFailure = true;

    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("rejects transport failures even when Docker exits nonzero", async () => {
    spawnState.transportFailure = true;
    spawnState.transportExitCode = 7;

    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("does not include raw container arguments when stderr is empty", async () => {
    spawnState.plainExitWithoutStderr = true;
    const secret = "sandbox-secret-value";

    const error = await execDockerRaw(["create", "--env", `TOKEN=${secret}`]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Docker command failed (exit 1)");
    expect((error as Error).message).not.toContain(secret);
  });
});
