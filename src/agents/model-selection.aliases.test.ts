import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";

function aliasIndex(cfg: OpenClawConfig, agentId?: string) {
  return buildModelAliasIndex({
    cfg,
    agentId,
    defaultProvider: "openai",
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
}

describe("multiple configured model aliases", () => {
  it("resolves all names case-insensitively without crossing provider-qualified aliases", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/model-a": { alias: "primary", aliases: [" Fast ", "PRIMARY", "fast"] },
            "other/model-b": { aliases: ["fast"] },
          },
        },
      },
    };
    const index = aliasIndex(cfg);
    expect(index.byKey.get("openai/model-a")).toEqual(["primary", "Fast"]);
    for (const raw of ["PRIMARY", "openai/FAST"]) {
      expect(
        resolveModelRefFromString({ cfg, raw, defaultProvider: "openai", aliasIndex: index })?.ref,
      ).toEqual({ provider: "openai", model: "model-a" });
    }
    expect(
      resolveModelRefFromString({ cfg, raw: "FAST", defaultProvider: "openai", aliasIndex: index })
        ?.ref,
    ).toEqual({ provider: "other", model: "model-b" });
  });

  it.each([
    { entry: { params: { temperature: 0.2 } }, names: ["primary", "secondary"] },
    {
      entry: { aliases: ["worker-primary", "worker-extra"] },
      names: ["worker-primary", "worker-extra"],
    },
    { entry: { aliases: [] }, names: [] },
    { entry: { alias: "" }, names: [] },
  ])(
    "applies per-agent alias replacement without reviving inherited names: %j",
    ({ entry, names }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/model-a": { alias: "primary", aliases: ["secondary"] } } },
          entries: { worker: { models: { "openai/model-a": entry } } },
        },
      };
      const index = aliasIndex(cfg, "worker");
      expect(index.byKey.get("openai/model-a") ?? []).toEqual(names);
      expect([...index.byAlias.keys()]).toEqual(names);
    },
  );
});
