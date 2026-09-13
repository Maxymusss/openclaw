import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAnthropicUsage, resolveAnthropicUsageAuth } from "./usage.js";

const SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

async function resolveSetupUsageToken(env: NodeJS.ProcessEnv): Promise<string> {
  const result = await resolveAnthropicUsageAuth({
    config: {},
    env,
    provider: "anthropic",
    resolveApiKeyFromConfigAndStore: () => SETUP_TOKEN,
    resolveOAuthToken: async () => null,
  });
  if (!("token" in result)) {
    throw new Error("expected setup-token usage auth to resolve a token");
  }
  return result.token;
}

describe("Anthropic setup-token usage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks configured setup-token usage separately from OAuth credentials", async () => {
    const token = await resolveSetupUsageToken({
      CLAUDE_AI_SESSION_KEY: "sk-ant-session-key",
    });

    expect(token).not.toBe(SETUP_TOKEN);
  });

  it("uses web usage directly for a resolved setup token without calling OAuth usage", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");
    const token = await resolveSetupUsageToken(process.env);
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
      token,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 17, resetAt: undefined }]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("preserves OAuth usage for a full-length sk-ant-oat token", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_COOKIE", "");
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);
      expect(url.hostname).toBe("api.anthropic.com");
      expect(url.pathname).toBe("/api/oauth/usage");
      return new Response(JSON.stringify({ five_hour: { utilization: 23 } }), { status: 200 });
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
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 23, resetAt: undefined }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("surfaces configured web-session failures", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");
    const token = await resolveSetupUsageToken(process.env);
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    const result = await fetchAnthropicUsage({
      config: {},
      env: process.env,
      provider: "anthropic",
      token,
      timeoutMs: 5_000,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(result).toMatchObject({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [],
      error: "Claude web usage unavailable",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("silently skips setup-token usage when no supported web session is configured", async () => {
    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => SETUP_TOKEN,
      resolveOAuthToken: async () => null,
    });

    expect(result).toEqual({ handled: true });
  });
});
