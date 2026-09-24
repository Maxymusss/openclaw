import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerWorktreesCli } from "../../cli/worktrees-cli.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { requireGit } from "./git.js";
import {
  admitWorktreeRunLeaseRow,
  getRegistryWorktree,
  insertRegistryWorktree,
} from "./registry.js";
import { IDLE_GC_MS, ManagedWorktreeService, managedWorktrees } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetConfigRuntimeState();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
const initializeRepository = useManagedWorktreeTestRepository();

it("finishes CLI cleanup with moved HEADs, missing gitdirs, and 600 mixed registry records", async () => {
  const root = tempDirs.make("openclaw-gc-classification-");
  const repo = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const now = 1_700_000_000_000;
  const [moved, orphan, ...idle] = await materializeManagedWorktreeFixtures({
    env,
    repoRoot: repo,
    stateDir,
    now: now - IDLE_GC_MS - 1,
    ownerKind: "workboard",
    names: ["a-moved", "b-orphan", "idle-1", "idle-2", "idle-3", "idle-4"],
  });
  await requireGit(moved!.path, ["checkout", "--detach"]);
  const gitdir = await requireGit(orphan!.path, ["rev-parse", "--absolute-git-dir"]);
  await fs.rm(gitdir, { recursive: true });
  await fs.writeFile(path.join(orphan!.path, "local.txt"), "preserve uncertain checkout files\n");
  // The cheap protected rows need no physical checkout: protection must precede Git inspection.
  runOpenClawStateWriteTransaction(
    () => {
      for (let index = 0; index < 594; index++) {
        const id = `protected-${String(index).padStart(3, "0")}`;
        insertRegistryWorktree(env, {
          ...moved!,
          id,
          name: id,
          path: repo,
          ownerKind: index >= 590 ? "manual" : "workboard",
          ownerId: index < 390 ? "active-owner" : id,
        });
        if (index >= 390 && index < 590) {
          admitWorktreeRunLeaseRow(env, {
            worktreeId: id,
            token: id,
            pid: process.pid,
            startTime: null,
            now,
          });
        }
      }
      admitWorktreeRunLeaseRow(env, {
        worktreeId: idle[0]!.id,
        token: "dead-owner",
        pid: 2_147_483_647,
        startTime: null,
        now,
      });
    },
    { env },
  );
  const service = new ManagedWorktreeService({ env, now: () => now });
  setRuntimeConfigSnapshot({}, {});
  vi.spyOn(managedWorktrees, "gc").mockImplementation((params) =>
    service.gc({
      ...params,
      shouldProtectOwner: (_kind, id) => id === "active-owner",
      shouldRemoveOwner: () => false,
    }),
  );
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  const protections = vi.spyOn(WorktreeGcProgress.prototype, "protect");
  const program = new Command().name("openclaw");
  registerWorktreesCli(program);
  const started = performance.now();
  let exitCode = 0;
  try {
    await program.parseAsync(["worktrees", "gc", "--json"], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exitCode = error.code;
  }
  const distribution: Record<string, number> = {};
  for (const call of protections.mock.calls) {
    const reason = call[2];
    distribution[reason] = (distribution[reason] ?? 0) + 1;
  }
  console.log(
    JSON.stringify({
      records: 600,
      exitCode,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      distribution,
      result: output.mock.calls[0]?.[0],
    }),
  );
  expect(exitCode).toBe(0);
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "deferred",
      removed: idle.map((record) => record.id),
      orphansRetired: 1,
      protectedCount: 595,
      protectionReasons: {
        "owner is active": 390,
        "run lease is active": 200,
        "manual worktrees require explicit removal": 4,
        "branch-moved": 1,
      },
      issues: expect.arrayContaining([
        expect.objectContaining({ id: orphan!.id, reason: expect.stringContaining(orphan!.path) }),
      ]),
    }),
  );
  expect(getRegistryWorktree(env, orphan!.id)?.removedAt).toBe(now);
  expect((await service.list()).some((record) => record.id === orphan!.id)).toBe(false);
  await expect(service.restore({ id: orphan!.id })).rejects.toThrow("is not restorable");
  expect(await requireGit(repo, ["rev-parse", "--verify", orphan!.branch])).toBeTruthy();
  expect(getRegistryWorktree(env, moved!.id)?.removedAt).toBeUndefined();
  expect(await requireGit(repo, ["rev-parse", "--verify", moved!.branch])).toBeTruthy();
  expect(await fs.readFile(path.join(orphan!.path, "local.txt"), "utf8")).toBe(
    "preserve uncertain checkout files\n",
  );
  for (const record of idle) {
    expect(getRegistryWorktree(env, record.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("preserves a recent orphan when its owner becomes live during cleanup", async () => {
  const root = tempDirs.make("openclaw-gc-owner-revived-");
  const repo = await initializeRepository(root);
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const now = 1_700_000_000_000;
  const [record] = await materializeManagedWorktreeFixtures({
    env,
    repoRoot: repo,
    stateDir,
    now,
    ownerKind: "workboard",
    ownerId: "revived-owner",
    names: ["recent-orphan"],
  });
  const gitdir = await requireGit(record!.path, ["rev-parse", "--absolute-git-dir"]);
  await fs.rm(gitdir, { recursive: true });
  const service = new ManagedWorktreeService({ env, now: () => now });
  const result = await service.gc({
    limits: {},
    shouldProtectOwner: () => false,
    shouldRemoveOwner: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
  });
  expect(result).toMatchObject({ removed: [], orphansRetired: 0, outcome: "deferred" });
  expect(getRegistryWorktree(env, record!.id)?.removedAt).toBeUndefined();
});
