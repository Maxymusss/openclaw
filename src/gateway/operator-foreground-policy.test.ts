import { afterEach, expect, it, vi } from "vitest";
import { bindPluginGatewayAccessPolicy } from "../plugins/gateway-access-policy-registration.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  GatewayOperatorAccessDeniedError,
  resolveGatewayOperatorAccessAuthority,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";

afterEach(() => clearActivePluginRegistry());

function installRawPolicy(policy: PluginGatewayAccessPolicy) {
  const registry = createEmptyPluginRegistry();
  const pluginId = "foreground-policy-test";
  registry.plugins.push(
    createPluginRecord({
      id: pluginId,
      source: "foreground-policy-test",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    }),
  );
  registry.gatewayAccessPolicies.push({
    pluginId,
    source: "foreground-policy-test",
    policy: bindPluginGatewayAccessPolicy(policy, undefined),
  });
  setActivePluginRegistry(registry, "foreground-policy-test", "gateway-bindable");
  return registry;
}

it.each(["foreground-only", "unknown", null, false])(
  "refuses an unqualified raw instance-free restriction %s at the host boundary",
  async (restriction) => {
    await withOpenClawTestState({ label: "foreground-policy" }, async () => {
      const authorize = vi.fn(() =>
        Object.defineProperty(
          {
            signal: new AbortController().signal,
            assertCurrent() {},
          },
          "executionPolicy",
          { value: restriction },
        ),
      );
      installRawPolicy({ authorize });
      const profile = ensureProfileForEmail("foreground@example.test");
      expect(() => resolveGatewayOperatorAccessAuthority(profile.id, {})).toThrow(
        GatewayOperatorAccessDeniedError,
      );
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ supportedExecutionPolicies: [] }),
      );
    });
  },
);

it("preserves unrestricted null access versus a non-durable policy authority", async () => {
  await withOpenClawTestState({ label: "foreground-policy-unrestricted" }, async () => {
    const profile = ensureProfileForEmail("unrestricted@example.test");
    installRawPolicy({ authorize: () => undefined });
    expect(resolveGatewayOperatorAccessAuthority(profile.id, {})).toBeNull();
    const grant = new AbortController();
    const registry = installRawPolicy({
      authorize: () => ({
        signal: grant.signal,
        assertCurrent: () => grant.signal.throwIfAborted(),
      }),
    });
    const authority = resolveGatewayOperatorAccessAuthority(profile.id, {});
    expect(authority).not.toBeNull();
    expect(authority?.gatewayAccessGrant).toBeUndefined();
    expect(authority?.executionPolicy).toBeUndefined();
    // Registry removal cannot detach the already captured original source.
    registry.gatewayAccessPolicies.length = 0;
    grant.abort(new Error("original access ended"));
    expect(authority?.signal.aborted).toBe(true);
    expect(() => authority?.assertCurrent()).toThrow(GatewayOperatorAccessDeniedError);
  });
});

it("does not recover a durable request as foreground work after promotion", () => {
  const grantId = "13b319d9-7794-4b2c-bd10-45fa9db62a8d";
  installRawPolicy({
    authorize: () => undefined,
    resume: () => ({
      grantId,
      executionPolicy: "foreground-only",
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
  });
  expect(() =>
    resumeGatewayOperatorAccessGrant(
      {
        profileId: "original-profile",
        emails: ["original@example.test"],
        assignedRole: null,
      },
      {},
      { pluginId: "foreground-policy-test", grantId },
    ),
  ).toThrow(GatewayOperatorAccessDeniedError);
});
