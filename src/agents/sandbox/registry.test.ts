// Sandbox registry tests cover SQLite ordering and race safety for container/browser runtime records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { TEST_STATE_DIR, PREVIOUS_OPENCLAW_STATE_DIR, SANDBOX_REGISTRY_PATH } = vi.hoisted(() => {
  const nodePath = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(nodePath.join(tmpdir(), "openclaw-sandbox-registry-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", baseDir);

  return {
    TEST_STATE_DIR: baseDir,
    PREVIOUS_OPENCLAW_STATE_DIR: previousStateDir,
    SANDBOX_REGISTRY_PATH: nodePath.join(baseDir, "containers.json"),
  };
});

import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import {
  readBrowserRegistry,
  assertSandboxRegistryEntryCurrent,
  completeSandboxRegistryReservation,
  reserveSandboxRegistryEntry,
  assertSandboxBrowserRegistryEntryCurrent,
  readRegisteredSandboxRuntimeIds,
  readRegistry,
  readRegistryEntry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime,
  updateBrowserRegistry,
  updateRegistry,
} from "./registry.js";

type SandboxBrowserRegistryEntry = import("./registry.js").SandboxBrowserRegistryEntry;
type SandboxRegistryEntry = import("./registry.js").SandboxRegistryEntry;

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(path.join(TEST_STATE_DIR, "state"), { recursive: true, force: true });
  await fs.rm(SANDBOX_REGISTRY_PATH, { force: true });
});

afterAll(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await fs.rm(TEST_STATE_DIR, { recursive: true, force: true });
  if (PREVIOUS_OPENCLAW_STATE_DIR === undefined) {
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
  } else {
    setTestEnvValue("OPENCLAW_STATE_DIR", PREVIOUS_OPENCLAW_STATE_DIR);
  }
});

function browserEntry(
  overrides: Partial<SandboxBrowserRegistryEntry> = {},
): SandboxBrowserRegistryEntry {
  return {
    containerName: "browser-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-browser:test",
    cdpPort: 9222,
    ...overrides,
  };
}

function containerEntry(overrides: Partial<SandboxRegistryEntry> = {}): SandboxRegistryEntry {
  return {
    containerName: "container-a",
    sessionKey: "agent:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-sandbox:test",
    ...overrides,
  };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
    throw new Error(`expected ${targetPath} to be missing`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    expect(code).toBe("ENOENT");
  }
}

describe("registry race safety", () => {
  it.each(["foreground-owner", "future-policy", null])(
    "retains present policy %j across updates, publication, reopen and generic deletion",
    async (retirementPolicy) => {
      const initial = containerEntry({
        backendId: "docker",
        runtimeLabel: "container-a",
        configLabelKind: "Image",
        workspaceDir: "/owned/workspace",
      });
      const reserved = reserveSandboxRegistryEntry(initial);
      // Unknown persisted values are input data, not a new policy exposed to callers.
      runOpenClawStateWriteTransaction(({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("sandbox_registry_entries")
            .set({ entry_json: JSON.stringify({ ...reserved, retirementPolicy }) })
            .where("registry_kind", "=", "container")
            .where("container_name", "=", reserved.containerName),
        );
      });
      const expected = await readRegistryEntry(initial.containerName);
      if (!expected) {
        throw new Error("missing seeded registry row");
      }
      await updateRegistry({ ...initial, lastUsedAtMs: 2 });
      completeSandboxRegistryReservation(expected, { ...initial, lastUsedAtMs: 3 });
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      const current = await readRegistryEntry(initial.containerName);
      expect(current).toEqual({ ...expected, runtimeState: "ready", lastUsedAtMs: 3 });
      expect(current?.retirementPolicy).toBe(retirementPolicy);
      if (!current) {
        throw new Error("missing reopened registry row");
      }
      const cleanup = vi.fn(async () => {});
      await expect(removeSandboxRegistryRuntime(current, cleanup)).rejects.toThrow(
        "custody retained",
      );
      await expect(removeRegistryEntry(current.containerName)).rejects.toThrow("custody retained");
      expect(() => removeSandboxRegistryGeneration("container", current, () => {})).toThrow(
        "custody retained",
      );
      expect(() => reserveSandboxRegistryEntry(initial)).toThrow("custody retained");
      expect(cleanup).not.toHaveBeenCalled();
      await expect(readRegistryEntry(initial.containerName)).resolves.toEqual(current);
    },
  );

  it("does not let a new private candidate adopt an existing unmarked reservation", async () => {
    const candidate = containerEntry({ backendId: "docker", workspaceDir: "/owned/workspace" });
    const existing = reserveSandboxRegistryEntry(candidate);
    const snapshot = await readRegistryEntry(existing.containerName);
    expect(() =>
      reserveSandboxRegistryEntry({ ...candidate, retirementPolicy: "foreground-owner" }),
    ).toThrow("cannot adopt");
    await expect(readRegistryEntry(existing.containerName)).resolves.toEqual(snapshot);
    completeSandboxRegistryReservation(existing);
    const owned = reserveSandboxRegistryEntry({
      ...candidate,
      retirementPolicy: "foreground-owner",
    });
    // The captured, never-dispatched reservation has one exact owner release path.
    completeSandboxRegistryReservation(owned);
    await expect(readRegistryEntry(owned.containerName)).resolves.toBeNull();
  });

  it.each([
    { runtimeState: "removing" as const },
    { runtimeState: "removing-pending" as const },
    { backendId: "other-backend" },
    { sessionKey: "other-session" },
    { createdAtMs: 2 },
    { workspaceDir: "/other/workspace" },
    { configHash: "other-config" },
    { retirementPolicy: "foreground-owner" as const },
    { backendTarget: { key: "other-target", globalArgs: ["--url", "unix:///other.sock"] } },
  ])("rejects stale reservation publication and deletion after %j", async (changed) => {
    const reservation = reserveSandboxRegistryEntry(
      containerEntry({
        backendId: "reserved-backend",
        runtimeLabel: "container-a",
        configLabelKind: "Image",
        workspaceDir: "/owned/workspace",
        configHash: "original-config",
        backendTarget: { key: "original-target", globalArgs: ["--url", "unix:///owned.sock"] },
      }),
    );
    // Replace the authoritative generation through the real SQLite owner.
    // updateRegistry intentionally preserves several of these identity fields.
    await removeRegistryEntry(reservation.containerName);
    const successor = { ...reservation, ...changed };
    await updateRegistry(successor);
    expect(() => assertSandboxRegistryEntryCurrent(reservation)).toThrow();
    expect(() => completeSandboxRegistryReservation(reservation, reservation)).toThrow();
    await expect(readRegistryEntry(reservation.containerName)).resolves.toEqual(successor);
    expect(() => completeSandboxRegistryReservation(reservation)).toThrow();
    await expect(readRegistryEntry(reservation.containerName)).resolves.toEqual(successor);
  });

  it("publishes allocation facts against the captured reservation and retires only that generation", async () => {
    const reservation = reserveSandboxRegistryEntry(
      containerEntry({
        backendId: "reserved-backend",
        runtimeLabel: "container-a",
        configLabelKind: "Image",
        workspaceDir: "/owned/workspace",
      }),
    );
    const published = { ...reservation, image: "resolved-image", configHash: "resolved-config" };
    completeSandboxRegistryReservation(reservation, published);
    const current = { ...published, runtimeState: "ready" as const };
    await expect(readRegistryEntry(reservation.containerName)).resolves.toEqual(current);
    expect(() => assertSandboxRegistryEntryCurrent(current)).not.toThrow();
    // Allocation facts may differ from the pending receipt; the old receipt
    // must not subsequently authorize deletion of the published generation.
    expect(() => completeSandboxRegistryReservation(reservation)).toThrow("generation changed");
    await updateRegistry({ ...current, lastUsedAtMs: 99 });
    expect(() => assertSandboxRegistryEntryCurrent(current)).not.toThrow();
    completeSandboxRegistryReservation(current);
    await expect(readRegistryEntry(reservation.containerName)).resolves.toBeNull();
  });

  it.each([
    { containerName: "other-runtime" },
    { backendId: "other-backend" },
    { sessionKey: "other-session" },
  ])("never publishes a different reservation identity: %j", async (changed) => {
    const reservation = reserveSandboxRegistryEntry(
      containerEntry({
        backendId: "reserved-backend",
        runtimeLabel: "container-a",
        configLabelKind: "Image",
        workspaceDir: "/owned/workspace",
      }),
    );
    expect(() =>
      completeSandboxRegistryReservation(reservation, { ...reservation, ...changed }),
    ).toThrow("publication changed reservation identity");
    await expect(readRegistryEntry(reservation.containerName)).resolves.toEqual(reservation);
    expect((await readRegistry()).entries).toHaveLength(1);
  });

  it("retains exact browser workspace custody and rejects a rebound owner", async () => {
    await updateBrowserRegistry(browserEntry({ workspaceDir: "/private/workspace" }));
    await updateBrowserRegistry(browserEntry({ lastUsedAtMs: 2 }));
    const [selected] = (await readBrowserRegistry()).entries;
    expect(selected?.workspaceDir).toBe("/private/workspace");
    expect(() => assertSandboxBrowserRegistryEntryCurrent(selected!)).not.toThrow();
    await updateBrowserRegistry(browserEntry({ workspaceDir: "/other/workspace" }));
    expect(() => assertSandboxBrowserRegistryEntryCurrent(selected!)).toThrow("owner changed");
  });

  it("does not migrate legacy registry files from runtime reads", async () => {
    // Runtime reads should ignore old monolithic files; explicit doctor/repair
    // owns migration so normal startup cannot mutate registry layout.
    const legacyEntry = containerEntry({ containerName: "legacy-container" });
    await fs.writeFile(
      SANDBOX_REGISTRY_PATH,
      `${JSON.stringify({ entries: [legacyEntry] }, null, 2)}\n`,
      "utf-8",
    );

    await expect(readRegistry()).resolves.toEqual({ entries: [] });
    await expect(readRegistryEntry("legacy-container")).resolves.toBeNull();
    await expect(fs.access(SANDBOX_REGISTRY_PATH)).resolves.toBeUndefined();
    await expectPathMissing(path.join(TEST_STATE_DIR, "state", "openclaw.sqlite"));
  });

  it("reads a single SQLite entry without scanning the full registry", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x", sessionKey: "sess:x" }));
    await updateRegistry(containerEntry({ containerName: "container-y", sessionKey: "sess:y" }));

    const entry = await readRegistryEntry("container-x");
    expect(entry?.containerName).toBe("container-x");
    expect(entry?.sessionKey).toBe("sess:x");
    await expect(readRegistryEntry("missing-container")).resolves.toBeNull();
  });

  it("preserves a Podman target across registry usage updates", async () => {
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        backendTarget: {
          key: "machine:target-a",
          globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
        },
      }),
    );
    await updateRegistry(
      containerEntry({
        backendId: "podman",
        lastUsedAtMs: 2,
      }),
    );

    await expect(readRegistryEntry("container-a")).resolves.toMatchObject({
      backendId: "podman",
      backendTarget: {
        key: "machine:target-a",
        globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
      },
      lastUsedAtMs: 2,
    });
  });

  it("reads registered runtime IDs for one backend and scope newest first", async () => {
    await updateRegistry(
      containerEntry({
        containerName: "openshell-older",
        backendId: "openshell",
        sessionKey: "agent:main",
        lastUsedAtMs: 10,
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "openshell-newer",
        backendId: "openshell",
        sessionKey: "agent:main",
        lastUsedAtMs: 20,
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "docker-same-scope",
        backendId: "docker",
        sessionKey: "agent:main",
        lastUsedAtMs: 30,
      }),
    );
    await updateRegistry(
      containerEntry({
        containerName: "openshell-other-scope",
        backendId: "openshell",
        sessionKey: "agent:other",
        lastUsedAtMs: 40,
      }),
    );

    await expect(
      readRegisteredSandboxRuntimeIds({
        backendId: "openshell",
        scopeKey: "agent:main",
      }),
    ).resolves.toEqual(["openshell-newer", "openshell-older"]);
  });

  it("keeps both container updates under concurrent writes", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["container-a", "container-b"]);
  });

  it("prevents concurrent container remove/update from resurrecting deleted entries", async () => {
    await updateRegistry(containerEntry({ containerName: "container-x" }));

    const updatePromise = updateRegistry(
      containerEntry({ containerName: "container-x", configHash: "updated" }),
    );
    const removePromise = removeRegistryEntry("container-x");
    await Promise.all([updatePromise, removePromise]);

    const registry = await readRegistry();
    expect(registry.entries).toHaveLength(0);
  });

  it("stores unsafe container names without writing path-derived files", async () => {
    await updateRegistry(containerEntry({ containerName: "../escape" }));

    const registry = await readRegistry();

    expect(registry.entries.map((entry) => entry.containerName)).toEqual(["../escape"]);
    await expectPathMissing(`${TEST_STATE_DIR}/escape.json`);
  });

  it("returns registry entries in deterministic container-name order", async () => {
    await Promise.all([
      updateRegistry(containerEntry({ containerName: "container-c" })),
      updateRegistry(containerEntry({ containerName: "container-a" })),
      updateRegistry(containerEntry({ containerName: "container-b" })),
    ]);

    const registry = await readRegistry();
    expect(registry.entries.map((entry) => entry.containerName)).toEqual([
      "container-a",
      "container-b",
      "container-c",
    ]);
  });

  it("keeps both browser updates under concurrent writes", async () => {
    await Promise.all([
      updateBrowserRegistry(browserEntry({ containerName: "browser-a" })),
      updateBrowserRegistry(browserEntry({ containerName: "browser-b", cdpPort: 9223 })),
    ]);

    const registry = await readBrowserRegistry();
    expect(
      registry.entries
        .map((entry) => entry.containerName)
        .slice()
        .toSorted(),
    ).toEqual(["browser-a", "browser-b"]);
  });

  it("prevents concurrent browser remove/update from resurrecting deleted entries", async () => {
    await updateBrowserRegistry(browserEntry({ containerName: "browser-x" }));

    const updatePromise = updateBrowserRegistry(
      browserEntry({ containerName: "browser-x", configHash: "updated" }),
    );
    const removePromise = removeBrowserRegistryEntry("browser-x");
    await Promise.all([updatePromise, removePromise]);

    const registry = await readBrowserRegistry();
    expect(registry.entries).toHaveLength(0);
  });
});
