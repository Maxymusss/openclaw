import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

const SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

describe("Anthropic setup-token usage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the configured web-session fallback reachable for setup tokens", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: { CLAUDE_AI_SESSION_KEY: "sk-ant-session-key" },
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => SETUP_TOKEN,
      resolveOAuthToken: async () => null,
    });

    expect(result).toEqual({ token: SETUP_TOKEN });
  });

  it("uses web usage directly for a setup token without calling the OAuth usage endpoint", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      expect(url.hostname).not.toBe("api.anthropic.com");
      if (url.pathname === "/api/organizations") {
        return new Response(JSON.stringify([{ uuid: "org-123" }]), { status: 200 });
      }
      if (url.pathname === "/api/organizations/org-123/usage") {
        return new Response(JSON.stringify({ five_hour: { utilization: 17 } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await fetchAnthropicUsage({
      config: {},
      env: process.env,
      provider: "anthropic",
      token: SETUP_TOKEN,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 17, resetAt: undefined }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("silently skips setup-token usage when no supported web session is configured", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_COOKIE", "");
    const fetchFn = vi.fn(async () => {
      throw new Error("setup-token usage should not issue a network request");
    });

    const result = await fetchAnthropicUsage({
      config: {},
      env: process.env,
      provider: "anthropic",
      token: SETUP_TOKEN,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result).toMatchObject({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [],
    });
    expect(result.error).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
