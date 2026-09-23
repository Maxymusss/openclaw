import { describe, expect, it } from "vitest";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

describe("plugin-owned runtime auth", () => {
  it.each(["openai", "example-provider"])(
    "keeps %s logical auth independent of host profiles, credentials and transport",
    (provider) => {
      const prepared = prepareAgentRuntimeAuth({
        provider,
        modelId: "example-model",
        modelApi: "openai-responses",
        modelBaseUrl: "https://proxy.example.test/v1",
        harnessId: "configured-plugin",
        harnessRuntime: "configured-plugin",
        harnessAuthBootstrap: "plugin",
        env: { OPENAI_API_KEY: "unrelated-host-key" },
        config: {
          models: {
            providers: {
              [provider]: {
                baseUrl: "https://proxy.example.test/v1",
                api: "openai-responses",
                apiKey: "missing:host-profile",
                models: [],
              },
            },
          },
        },
        authProfileStore: {
          version: 1,
          profiles: {
            "host:available": createApiKeyCredential(provider, "host-profile-key"),
          },
        },
        sessionAuthProfileId: "missing:host-profile",
        sessionAuthProfileSource: "user",
        allowHarnessAuthProfileForwarding: false,
      });
      const expectedPlan = {
        providerForAuth: provider,
        modelId: "example-model",
        authProfileProviderForAuth: provider,
        harnessAuthProvider: "configured-plugin",
        credentialSource: { kind: "none" },
      };
      expect(prepared.plan).toEqual(expectedPlan);
      expect(prepared.attempts).toEqual([{ kind: "implicit", plan: expectedPlan }]);
    },
  );
});
