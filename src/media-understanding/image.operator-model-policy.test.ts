import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-operator-authority.js";
import {
  prepareOperatorModelPolicy,
  runWithOperatorModelAuthority,
} from "../agents/operator-model-policy.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { bindModelRequestRoute, readModelRequestRoute } from "../llm/model-runtime-binding.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  imageRuntimeMocks,
  installImageRuntimeTestHooks,
  preparedAuthStorage,
} from "./image.test-support.js";

const {
  completeMock,
  fetchMock,
  getApiKeyForModelMock,
  setRuntimeApiKeyMock,
  registerProviderStreamForModelMock,
  prepareProviderRuntimeAuthMock,
  releasePreparedModelRuntimeMock,
  resolveModelAsyncMock,
  shouldPreferProviderRuntimeResolvedModelMock,
} = imageRuntimeMocks;
const resolveProviderRuntimePluginHandleMock = vi.hoisted(() => vi.fn());
vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>()),
  resolveProviderRuntimePluginHandle: resolveProviderRuntimePluginHandleMock,
}));
const { describeImageWithModelCore, describeImagesWithModelCore } = await import("./image.js");

describe("image operator model selection", () => {
  installImageRuntimeTestHooks();
  beforeEach(() => {
    resolveProviderRuntimePluginHandleMock.mockReset().mockImplementation((params) => ({
      ...params,
      plugin: undefined,
    }));
  });
  it.each([
    "mapped",
    "unbound",
    "mutated",
    "auth-revoked",
    "refresh-revoked",
    "runtime-auth-revoked",
    "refresh-narrowed",
    "runtime-route-change",
    "staff",
  ] as const)("retains logical image selection and physical auth target (%s)", async (mode) => {
    const physical = makeProviderModelFixture({
      provider: "image-policy",
      id: "wire-model",
      api: "openai-completions",
      baseUrl: "https://image-policy.example/v1",
      input: ["text", "image"],
    });
    const mapped = bindModelRequestRoute(physical, {
      provider: physical.provider,
      model: "selected",
    });
    const model =
      mode === "unbound" ? physical : mode === "mutated" ? { ...mapped, id: "other" } : mapped;
    let policy = prepareOperatorModelPolicy({
      cfg: {},
      policy: { allow: ["image-policy/selected", "image-policy/other"] },
      manifestPlugins: [],
    });
    const source = new AbortController();
    const releases: ReturnType<typeof vi.fn>[] = [];
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "image-owner",
      scopes: ["operator.sessions.write"],
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
      get modelPolicy() {
        return mode === "staff" ? undefined : policy;
      },
      retain: () => {
        const release = vi.fn();
        releases.push(release);
        return release;
      },
    });
    const entered = createDeferred();
    const proceed = createDeferred();
    const stage = mode.startsWith("refresh-")
      ? "refresh"
      : mode.startsWith("runtime-")
        ? "runtime"
        : "auth";
    const hold = async (at: string) => {
      if (at === stage) {
        entered.resolve();
        await proceed.promise;
      }
    };
    let resolutions = 0;
    resolveModelAsyncMock.mockImplementation(async () => {
      resolutions += 1;
      if (resolutions > 1) {
        await hold("refresh");
      }
      return { model, authStorage: preparedAuthStorage, modelRegistry: {} };
    });
    shouldPreferProviderRuntimeResolvedModelMock.mockReturnValue(true);
    getApiKeyForModelMock.mockImplementation(async () => {
      await hold("auth");
      return {
        apiKey: "fixture-key",
        mode: "api-key",
        source: "fixture",
        profileId: "image-policy:backup",
      };
    });
    prepareProviderRuntimeAuthMock.mockImplementation(async () => {
      await hold("runtime");
      return mode === "runtime-route-change"
        ? { apiKey: "fixture-key", baseUrl: "https://other.example/v1" }
        : undefined;
    });
    completeMock.mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "Mapped image" }],
      stopReason: "stop",
    });
    const owner = new AsyncWorkScope();
    const pending = owner.run(() =>
      runWithOperatorModelAuthority(authority, () =>
        describeImageWithModelCore({
          cfg: {},
          agentDir: "/tmp/image-policy",
          provider: physical.provider,
          model: "selected",
          buffer: Buffer.from("image"),
          fileName: "image.png",
          mime: "image/png",
          timeoutMs: 5_000,
        }),
      ),
    );
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      if (mode !== "unbound" && mode !== "mutated") {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Image auth hold missed");
          }),
        ]);
        expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
        expect(completeMock).not.toHaveBeenCalled();
        expect(releasePreparedModelRuntimeMock).not.toHaveBeenCalled();
        if (mode.endsWith("revoked")) {
          source.abort(new Error("original image source revoked"));
        }
        if (mode === "refresh-narrowed") {
          policy = prepareOperatorModelPolicy({
            cfg: {},
            policy: { allow: [] },
            manifestPlugins: [],
          });
        }
      }
      proceed.resolve();
      const result = await outcome;
      if (mode === "mapped" || mode === "staff") {
        expect(result).toEqual({ value: { text: "Mapped image", model: "wire-model" } });
        expect(resolveModelAsyncMock).toHaveBeenCalledTimes(2);
        expect(resolveModelAsyncMock.mock.calls[1]?.slice(0, 2)).toEqual([
          physical.provider,
          "selected",
        ]);
        expect(resolveModelAsyncMock.mock.calls[1]?.[4]).toMatchObject({
          modelIdSource: "selected",
          authProfileId: "image-policy:backup",
        });
        expect(getApiKeyForModelMock).toHaveBeenCalledWith(
          expect.objectContaining({
            model: expect.objectContaining({ provider: physical.provider, id: "wire-model" }),
          }),
        );
        expect(prepareProviderRuntimeAuthMock.mock.calls[0]?.[0]).toMatchObject({
          provider: physical.provider,
          context: { modelId: "wire-model" },
        });
        expect(readModelRequestRoute(completeMock.mock.calls[0]![0])?.logicalRef).toEqual({
          provider: physical.provider,
          model: "selected",
        });
      } else {
        expect(result).toHaveProperty("error");
        expect(setRuntimeApiKeyMock).not.toHaveBeenCalled();
        expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
        expect(completeMock).not.toHaveBeenCalled();
        if (stage !== "runtime") {
          expect(prepareProviderRuntimeAuthMock).not.toHaveBeenCalled();
        }
        if (mode === "unbound" || mode === "mutated") {
          expect(getApiKeyForModelMock).not.toHaveBeenCalled();
        }
      }
    } finally {
      proceed.resolve();
      await outcome;
      await AsyncWorkScope.runWhenAllIdle(
        () => [owner],
        () => owner.drain(),
      );
    }
    expect(releasePreparedModelRuntimeMock).toHaveBeenCalledTimes(1);
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(release).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["mapped", "mapped-revoked", "unknown", "unknown-revoked", "staff"] as const)(
    "preserves resolved versus unknown MiniMax authorization for each image (%s)",
    async (mode) => {
      const unknown = mode.startsWith("unknown");
      const logical = unknown
        ? { provider: "minimax-portal", model: "MiniMax-VL-01" }
        : { provider: "image-policy", model: "selected" };
      const model = bindModelRequestRoute(
        makeProviderModelFixture({
          provider: "minimax-portal",
          id: "MiniMax-VL-01",
          api: "openai-completions",
          baseUrl: "https://api.minimax.io",
          input: ["text", "image"],
        }),
        logical,
      );
      if (unknown) {
        resolveModelAsyncMock.mockRejectedValue(
          new Error("Unknown model: minimax-portal/MiniMax-VL-01"),
        );
      } else {
        resolveModelAsyncMock.mockResolvedValue({
          model,
          authStorage: preparedAuthStorage,
          modelRegistry: {},
        });
      }
      const source = new AbortController();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "minimax-owner",
        scopes: ["operator.sessions.write"],
        signal: source.signal,
        assertCurrent: () => source.signal.throwIfAborted(),
        modelPolicy:
          mode === "staff"
            ? undefined
            : prepareOperatorModelPolicy({
                cfg: {},
                policy: { allow: [`${logical.provider}/${logical.model}`] },
                manifestPlugins: [],
              }),
      });
      const entered = createDeferred();
      const proceed = createDeferred();
      fetchMock.mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        return Response.json({ base_resp: { status_code: 0 }, content: "First image" });
      });
      const owner = new AsyncWorkScope();
      const pending = owner.run(() =>
        runWithOperatorModelAuthority(authority, () =>
          describeImagesWithModelCore({
            cfg: {},
            agentDir: "/tmp/image-policy",
            ...logical,
            timeoutMs: 5_000,
            images: [
              { buffer: Buffer.from("one"), fileName: "one.png", mime: "image/png" },
              { buffer: Buffer.from("two"), fileName: "two.png", mime: "image/png" },
            ],
          }),
        ),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("MiniMax request hold missed");
          }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (mode.endsWith("revoked")) {
          source.abort(new Error("original MiniMax source revoked"));
        }
        proceed.resolve();
        const result = await outcome;
        if (mode.endsWith("revoked")) {
          expect(result).toHaveProperty("error");
          expect(fetchMock).toHaveBeenCalledTimes(1);
        } else {
          expect(result).toMatchObject({
            value: { model: "MiniMax-VL-01", text: expect.stringContaining("First image") },
          });
          expect(fetchMock).toHaveBeenCalledTimes(2);
        }
        expect(completeMock).not.toHaveBeenCalled();
      } finally {
        proceed.resolve();
        await outcome;
        await AsyncWorkScope.runWhenAllIdle(
          () => [owner],
          () => owner.drain(),
        );
      }
      expect(releasePreparedModelRuntimeMock).toHaveBeenCalledTimes(1);
    },
  );
});
