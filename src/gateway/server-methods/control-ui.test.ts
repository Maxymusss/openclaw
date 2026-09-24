import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { createControlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({
  agents: { entries: { main: {} } },
  gateway: { controlUi: { github: { token: "preview-service-token" } } },
}));

describe("retired GitHub reader", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a terminal removal response without resolving credentials or fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("Removed readers must not resolve credentials");
    });
    const respond = vi.fn<RespondFn>();
    const handler = expectDefined(
      createControlUiHandlers()["controlUi.githubPreview"],
      "compatibility handler",
    );
    await handler(
      createControlUiRequestOptions(getRuntimeConfig)(
        { owner: "octocat", repo: "repo", kind: "issue", number: 1, refresh: true },
        respond,
      ),
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub link previews have been removed. Open the link on GitHub instead.",
      retryable: false,
    });
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not register the removed detail handler", () => {
    expect(createControlUiHandlers()).not.toHaveProperty("controlUi.githubDetail");
  });
});

describe("controlUi.sessionPullRequests.subscribe", () => {
  it("replaces the connection watch set", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions(
        { sessionKeys: [" agent:main:main ", "agent:main:main", "agent:work:main"] },
        respond,
        {
          client: { connId: "conn-control-ui" },
          context: { controlUiSessionPullRequests: { replace } },
        },
      ),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", ["agent:main:main", "agent:work:main"]);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
  });

  it("acknowledges a subscription before its cold snapshots finish loading", async () => {
    const { promise: hydration, resolve: finishHydration } = createDeferred();
    const replace = vi.fn(() => hydration);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    const request = expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: ["agent:main:cold"] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", ["agent:main:cold"]);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
    finishHydration();
    await request;
  });

  it("accepts an empty replace-set as unsubscribe", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", []);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: false }, undefined);
  });

  it("rejects malformed replace-sets", async () => {
    const replace = vi.fn();
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [" "] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPullRequests.subscribe params",
    });
  });
});

describe("controlUi.sessionPullRequests.checks", () => {
  const params = {
    sessionKey: "agent:main:ci-details",
    owner: "openclaw",
    repo: "openclaw",
    number: 103469,
    headSha: "a".repeat(40),
  };
  const result = {
    owner: params.owner,
    repo: params.repo,
    number: params.number,
    headSha: params.headSha,
    checks: [],
    status: "ready" as const,
    rateLimited: false,
  };

  it.each([
    { ...params, headSha: "main" },
    { ...params, owner: "../other" },
    { ...params, number: -1 },
    { ...params, url: "https://github.com/other/repo" },
    { ...params, sessionKey: "" },
  ])("rejects invalid or client-URL parameters before loading: %j", async (input) => {
    const load = vi.fn().mockResolvedValue(result);
    const handler = expectDefined(
      createControlUiHandlers(undefined, load)["controlUi.sessionPullRequests.checks"],
      "CI checks handler",
    );
    const respond = vi.fn<RespondFn>();
    await handler(requestOptions(input, respond));
    expect(load).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects unknown sessions without invoking the GitHub loader", async () => {
    await withOpenClawTestState({ label: "ci-details-unknown" }, async () => {
      const load = vi.fn().mockResolvedValue(result);
      const handler = expectDefined(
        createControlUiHandlers(undefined, load)["controlUi.sessionPullRequests.checks"],
        "CI checks handler",
      );
      const respond = vi.fn<RespondFn>();
      await handler(requestOptions(params, respond));
      expect(load).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
    });
  });

  it("binds the visible session generation and rechecks it before returning details", async () => {
    await withOpenClawTestState({ label: "ci-details-generation" }, async () => {
      const session = {
        agentId: "main",
        sessionKey: params.sessionKey,
        sessionId: "ci-generation-one",
      };
      await replaceSessionEntry(session, {
        sessionId: session.sessionId,
        updatedAt: 1,
        spawnedCwd: "/synthetic/ci",
      });
      const deferred = createDeferred<typeof result>();
      const started = createDeferred();
      const load = vi.fn(async () => {
        started.resolve();
        return deferred.promise;
      });
      const handler = expectDefined(
        createControlUiHandlers(undefined, load)["controlUi.sessionPullRequests.checks"],
        "CI checks handler",
      );
      const respond = vi.fn<RespondFn>();
      const request = handler(requestOptions(params, respond));
      await started.promise;
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ ...params, agentId: "main" }),
        expect.objectContaining({
          assertCurrent: expect.any(Function),
          sessionScope: expect.stringContaining("ci-generation-one"),
        }),
      );
      await replaceSessionEntry(session, {
        sessionId: "ci-generation-two",
        updatedAt: 2,
        spawnedCwd: "/synthetic/ci",
      });
      deferred.resolve(result);
      await request;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "Session changed; reopen CI details",
        }),
      );
    });
  });

  it.each([{ incognito: true as const }, { visibility: "draft" as const }])(
    "does not expose a hidden session to another profile: %j",
    async (hidden) => {
      await withOpenClawTestState({ label: "ci-details-hidden" }, async () => {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: params.sessionKey },
          {
            sessionId: "hidden-ci",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "owner" },
            ...hidden,
          },
        );
        const load = vi.fn().mockResolvedValue(result);
        const handler = expectDefined(
          createControlUiHandlers(undefined, load)["controlUi.sessionPullRequests.checks"],
          "CI checks handler",
        );
        const respond = vi.fn<RespondFn>();
        await handler({ ...requestOptions(params, respond), client: identifiedClient("viewer") });
        expect(load).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      });
    },
  );

  it("keeps qualified global sessions bound to their resolved agent", async () => {
    await withOpenClawTestState({ label: "ci-details-global" }, async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: { entries: { main: { default: true }, research: {} } },
      };
      await replaceSessionEntry(
        { agentId: "research", sessionKey: "global" },
        { sessionId: "research-ci", updatedAt: 1 },
      );
      const load = vi.fn().mockResolvedValue(result);
      const handler = expectDefined(
        createControlUiHandlers(undefined, load)["controlUi.sessionPullRequests.checks"],
        "CI checks handler",
      );
      const respond = vi.fn<RespondFn>();
      await handler(
        requestOptions({ ...params, sessionKey: "agent:research:main" }, respond, {
          context: { getRuntimeConfig: () => cfg },
        }),
      );
      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "research" }),
        expect.objectContaining({ sessionScope: expect.stringContaining("research-ci") }),
      );
      expect(respond).toHaveBeenCalledWith(true, result, undefined);
    });
  });
});

describe("controlUi.linkPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns no metadata and performs no external request when fetching is disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const respond = vi.fn();
    await createControlUiHandlers()["controlUi.linkPreview"]!(
      requestOptions({ url: "https://disabled.example/page" }, respond, {
        context: {
          getRuntimeConfig: () => ({
            gateway: { controlUi: { automaticallyFetchFavicons: false } },
          }),
        },
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, {}, undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { url: "http://127.0.0.1/private" },
    { url: "https://public.example", token: "not-forwarded" },
    {},
  ])("rejects malformed or private targets %j", async (params) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const respond = vi.fn();
    await createControlUiHandlers()["controlUi.linkPreview"]!(requestOptions(params, respond));
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("projects anonymous public metadata through the registered handler", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) =>
      (input instanceof Request ? input.url : input.toString()).endsWith("/favicon.ico")
        ? new Response(null, { status: 404 })
        : new Response('<head><meta property="og:title" content="Handler preview"></head>', {
            headers: { "content-type": "text/html" },
          }),
    );
    vi.stubGlobal("fetch", fetch);
    const respond = vi.fn();
    await createControlUiHandlers()["controlUi.linkPreview"]!(
      requestOptions({ url: "https://rpc-preview.example/page" }, respond),
    );
    expect(respond).toHaveBeenCalledWith(true, { title: "Handler preview" }, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
