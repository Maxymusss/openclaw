import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-operator-authority.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { controlUiClient } from "../server.sessions.create.projects.test-support.js";
import { testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test("sessions.create starts an owned empty workspace without reading the agent folder", async () => {
  const root = tempDirs.make("openclaw-session-empty-workspace-");
  const workspace = path.join(root, "agent-workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "private.txt"), "Must stay in the agent folder.");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:empty-workspace";
  const params = { key, agentId: "main", message: "", worktree: true, worktreeSource: "empty" };

  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    params,
    controlUiClient,
  );

  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const owned = managedWorktrees.findLiveByOwner("session", key);
  expect(owned).toBeDefined();
  try {
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionRoot: owned!.path,
      spawnedCwd: owned!.path,
      worktree: { id: owned!.id, repoRoot: owned!.repoRoot },
    });
    expect(await fs.readdir(owned!.path)).toEqual([".git"]);
    expect(await fs.readdir(workspace)).toEqual(["private.txt"]);
    await fs.writeFile(path.join(owned!.path, "result.txt"), "Keep this work.");

    const replay = await directSessionReq("sessions.create", params, controlUiClient);

    expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
    expect(managedWorktrees.findLiveByOwner("session", key)?.id).toBe(owned!.id);
    expect(await fs.readFile(path.join(owned!.path, "result.txt"), "utf8")).toBe("Keep this work.");
  } finally {
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test("sessions.create refuses a combined-policy initial turn before creating a workspace or session", async () => {
  const workspace = tempDirs.make("openclaw-foreground-create-");
  await fs.writeFile(path.join(workspace, "original.txt"), "Keep the original workspace.");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:foreground-create";
  const profile = ensureProfileForEmail("foreground-create@example.test");
  const client = identifiedClient(profile.id);
  const release = vi.fn();
  const retain = vi.fn(() => release);
  const source = new AbortController();
  client.internal = {
    operatorRunAuthority: createAdmittedRunOperatorAuthority({
      profileId: profile.id,
      scopes: ["operator.read", "operator.write"],
      permissions: { models: { allow: ["test-provider/test-model"] } },
      executionPolicy: "foreground-only",
      foregroundRunId: "original-create-turn",
      foregroundDeadlineAt: Date.now() + 60_000,
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
      retain,
    }),
  };
  const service = await import("../session-create-service.js");
  const root = await import("./session-create-root.js");
  const worktree = await import("../session-worktree-preparation.js");
  const create = vi.spyOn(service, "createGatewaySession");
  const filesystem = vi.spyOn(root, "prepareSessionCreateFilesystemRoot");
  const prepareWorktree = vi.spyOn(worktree, "prepareSessionWorktreeCreation");

  const result = await directSessionReq(
    "sessions.create",
    { key, agentId: "main", message: "Start a new task", worktree: true, worktreeSource: "empty" },
    { client, isWebchatConnect: () => true },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: expect.stringContaining("one foreground turn only") },
  });
  expect(create).not.toHaveBeenCalled();
  expect(filesystem).not.toHaveBeenCalled();
  expect(prepareWorktree).not.toHaveBeenCalled();
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
  expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
  expect(await fs.readdir(workspace)).toEqual(["original.txt"]);
  expect(await fs.readFile(path.join(workspace, "original.txt"), "utf8")).toBe(
    "Keep the original workspace.",
  );
  expect(retain).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

test.each([
  { worktree: false },
  { cwd: "/some/folder" },
  { projectId: "project" },
  { projectGitUrl: "https://github.com/openclaw/openclaw.git" },
  { repository: { url: "https://github.com/openclaw/openclaw.git" } },
  { catalogId: "external" },
  { execNode: "device" },
  { worktreeBaseRef: "other-session-branch" },
])("sessions.create rejects conflicting empty workspace selection %j", async (conflict) => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:conflicting-empty-workspace";
  const created = await directSessionReq(
    "sessions.create",
    { key, worktree: true, worktreeSource: "empty", ...conflict },
    controlUiClient,
  );

  expect(created).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining("worktreeSource=empty") },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
});
