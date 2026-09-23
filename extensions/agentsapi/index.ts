import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AgentsApiConfigSchema } from "./agentsapi-config.js";
import { createAgentsApiHarness } from "./agentsapi-harness.js";

export default definePluginEntry({
  id: "agentsapi",
  name: "OpenAI Agents API",
  description: "OpenAI Agents API harness and hosted sessions.",
  configSchema: () => buildPluginConfigSchema(AgentsApiConfigSchema),
  register(api) {
    const config = AgentsApiConfigSchema.parse(api.pluginConfig ?? {});
    api.registerAgentHarness(createAgentsApiHarness(api.runtime, config));
  },
});
