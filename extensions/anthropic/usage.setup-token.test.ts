import { describe, expect, it, vi } from "vitest";
import { resolveAnthropicUsageAuth } from "./usage.js";

describe("Anthropic setup-token usage auth", () => {
  it("does not poll Claude usage with a setup token", async () => {
    const resolveOAuthToken = vi.fn(async () => null);
    const setupToken = `sk-ant-oat01-${"a".repeat(80)}`;

    const result = await resolveAnthropicUsageAuth({
      config: {},
      env: {},
      provider: "anthropic",
      resolveApiKeyFromConfigAndStore: () => setupToken,
      resolveOAuthToken,
    });

    expect(result).toEqual({ handled: true });
    expect(resolveOAuthToken).toHaveBeenCalledWith({
      excludeProfileIds: ["anthropic:claude-cli"],
    });
  });
});
