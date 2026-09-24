import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import * as devInstallBranch from "../infra/dev-install-branch.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import { handleControlUiAvatarRequest, handleControlUiHttpRequest } from "./control-ui.js";
import { createGatewayHeldFixtureRunner } from "./held-fixture.test-support.js";

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

function createAvatarConfig(workspace: string, avatar: string): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace },
      list: [{ id: "main", workspace, identity: { avatar } }],
    },
  };
}

type HeldOwner = Parameters<
  Parameters<ReturnType<typeof createGatewayHeldFixtureRunner>["run"]>[1]
>[0];
async function withHeldResponseState(
  owner: HeldOwner,
  release: () => void,
  body: (track: HeldOwner["track"]) => Promise<void>,
) {
  const failures: unknown[] = [];
  let entered = false;
  await owner
    .track(
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        entered = true;
        const pending: Promise<unknown>[] = [];
        const track: HeldOwner["track"] = (promise, cleanup) => {
          pending.push(promise);
          return owner.track(promise, cleanup);
        };
        try {
          owner.signal.throwIfAborted();
          await body(track);
        } catch (error) {
          failures.push(error);
        }
        // The state owner may close only after the held handler has settled.
        try {
          release();
          while (pending.length) await Promise.allSettled(pending.splice(0));
        } catch (error) {
          failures.push(error);
        }
      }),
    )
    .catch((error: unknown) => {
      failures.push(error);
    });
  if (!entered && failures.length === 0) failures.push(new Error("response state did not enter"));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "response state failed", { cause: failures[0] });
}

describe("Control UI response authority", () => {
  const runner = createGatewayHeldFixtureRunner(onTestFinished);
  afterEach(runner.finishAfterEach);
  it("withholds prepared bootstrap bytes when visitor authority expires before its abort signal", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let req: IncomingMessage | undefined;
    let res: ServerResponse | undefined;
    await runner.run(
      release.resolve,
      async (owner) => {
        await withHeldResponseState(owner, release.resolve, async (track) => {
          const trustedProxy = { userHeader: "x-visitor-email", allowLoopback: true };
          const config: OpenClawConfig = {
            gateway: {
              auth: { mode: "trusted-proxy", trustedProxy },
              trustedProxies: ["127.0.0.1"],
            },
          };
          const auth: ResolvedGatewayAuth = {
            mode: "trusted-proxy",
            trustedProxy,
            allowTailscale: false,
          };
          setRuntimeConfigSnapshot(config);
          ensureProfileForEmail("visitor@example.test");
          const grant = new AbortController();
          const expiresAt = 1_000;
          let now = 0;
          const { registry } = createPluginRegistryFixture(config);
          registerVirtualTestPlugin({
            registry,
            config,
            id: "person-access",
            name: "Person access",
            register(api) {
              api.registerGatewayAccessPolicy({
                authorize: () => ({
                  signal: grant.signal,
                  assertCurrent() {
                    grant.signal.throwIfAborted();
                    if (now >= expiresAt) {
                      throw new Error("Visitor grant expired");
                    }
                  },
                }),
              });
              api.registerHttpRoute({
                path: "/secure-hook",
                auth: "gateway",
                match: "prefix",
                handler: async () => true,
              });
              api.session.controls.registerControlUiDescriptor({
                surface: "tab",
                id: "panel",
                label: "Visitor panel",
                path: "/secure-hook/panel",
              });
            },
          });
          setActivePluginRegistry(registry.registry);
          vi.spyOn(devInstallBranch, "resolveDevInstallGitBranch").mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return "private-branch";
          });
          req = new IncomingMessage(new Socket());
          Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
          req.method = "GET";
          req.url = CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
          req.headers = {
            "x-visitor-email": "visitor@example.test",
            "x-forwarded-for": "203.0.113.10",
            "x-openclaw-scopes": "operator.read",
          };
          res = new ServerResponse(req);
          const end = vi.spyOn(res, "end");
          owner.signal.throwIfAborted();
          const pending = track(
            handleControlUiHttpRequest(req, res, {
              config,
              cfg: config,
              auth,
              trustedProxies: config.gateway?.trustedProxies,
              getResolvedAuth: () => auth,
              getRuntimeConfig: () => config,
            }),
          );
          try {
            await racePromiseWithAbortSignal(
              Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("handler settled before preparation");
                }),
              ]),
              owner.signal,
            );
            expect(res.getHeader("Set-Cookie")).toEqual(
              expect.arrayContaining([expect.stringContaining("Path=/secure-hook")]),
            );
            now = expiresAt;
            expect(grant.signal.aborted).toBe(false);
            release.resolve();

            await expect(pending).rejects.toBeInstanceOf(Error);
            expect(res.destroyed).toBe(true);
            expect(res.headersSent).toBe(false);
            expect(end).not.toHaveBeenCalled();
          } finally {
            release.resolve();
          }
        });
      },
      async () => {
        res?.destroy();
        req?.destroy();
        req?.socket.destroy();
      },
    );
  });

  it.each(["avatar", "thumbnail", "bootstrap"] as const)(
    "withholds a prepared %s response after requester authority changes",
    async (kind) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let req: IncomingMessage | undefined;
      let res: ServerResponse | undefined;
      await runner.run(
        release.resolve,
        async (owner) => {
          const workspace = testTempDirs.make("openclaw-ui-response-authority-");
          await fs.writeFile(path.join(workspace, "avatar.png"), REAL_PNG);
          owner.signal.throwIfAborted();
          let config = createAvatarConfig(workspace, "avatar.png");
          if (kind === "bootstrap") {
            const registry = createEmptyPluginRegistry();
            registry.controlUiDescriptors.push({
              pluginId: "demo-plugin",
              source: "demo-plugin",
              descriptor: {
                surface: "tab",
                id: "demo",
                label: "Demo",
                path: "/secure-hook/panel",
              },
            });
            registry.httpRoutes.push({
              pluginId: "demo-plugin",
              source: "demo-plugin",
              path: "/secure-hook",
              auth: "gateway",
              match: "prefix",
              handler: async () => true,
            });
            setActivePluginRegistry(registry);
            vi.spyOn(devInstallBranch, "resolveDevInstallGitBranch").mockImplementation(
              async () => {
                entered.resolve();
                await release.promise;
                return "private-branch";
              },
            );
          } else {
            const read = boundaryFileRead.readFileDescriptorBounded;
            vi.spyOn(boundaryFileRead, "readFileDescriptorBounded").mockImplementation(
              async (...args) => {
                const body = await read(...args);
                entered.resolve();
                await release.promise;
                return body;
              },
            );
          }
          let auth: ResolvedGatewayAuth = {
            mode: "token",
            token: "admitted-token",
            allowTailscale: false,
          };
          req = new IncomingMessage(new Socket());
          Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
          req.method = "GET";
          req.url =
            kind === "bootstrap"
              ? CONTROL_UI_BOOTSTRAP_CONFIG_PATH
              : `/avatar/main${kind === "thumbnail" ? "?v=current" : ""}`;
          req.headers = { authorization: "Bearer admitted-token" };
          res = new ServerResponse(req);
          const end = vi.spyOn(res, "end");
          const setHeader = vi.spyOn(res, "setHeader");
          const handler =
            kind === "bootstrap" ? handleControlUiHttpRequest : handleControlUiAvatarRequest;
          owner.signal.throwIfAborted();
          const pending = owner.track(
            handler(req, res, {
              config,
              cfg: config,
              auth,
              getResolvedAuth: () => auth,
              getRuntimeConfig: () => config,
            }),
          );
          await racePromiseWithAbortSignal(
            Promise.race([
              entered.promise,
              pending.then(() => {
                throw new Error("handler settled before preparation");
              }),
            ]),
            owner.signal,
          );
          try {
            if (kind === "bootstrap") {
              expect(res.getHeader("Set-Cookie")).toEqual(
                expect.arrayContaining([expect.stringContaining("Path=/secure-hook")]),
              );
              config = { ...config, gateway: { roles: { definitions: {} } } };
            } else {
              auth = { ...auth, token: "replacement-token" };
            }
          } finally {
            release.resolve();
          }
          if (kind === "bootstrap") await expect(pending).rejects.toThrow("Unauthorized");
          else await expect(pending).resolves.toBe(true);

          expect(res.statusCode).toBe(401);
          expect(String(end.mock.calls[0]?.[0])).not.toContain("private-branch");
          expect(end).not.toHaveBeenCalledWith(REAL_PNG);
          expect(setHeader).not.toHaveBeenCalledWith("Content-Type", "image/png");
          expect(setHeader).not.toHaveBeenCalledWith("ETag", expect.anything());
          expect(res.getHeader("Set-Cookie")).toBeUndefined();
        },
        async () => {
          res?.destroy();
          req?.destroy();
          req?.socket.destroy();
        },
      );
    },
  );
});
