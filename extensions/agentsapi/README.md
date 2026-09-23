# Agents API harness

The `agentsapi` harness uses API-key authentication and an OpenAI-hosted Linux
environment. Select it through `agents.defaults.agentRuntime.id` or an agent's
`agentRuntime.id`. See the [harness configuration reference](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config).

Configure a dedicated credential at `plugins.entries.agentsapi.config.apiKey`:

```json5
{
  plugins: {
    entries: {
      agentsapi: {
        config: { apiKey: "${AGENTS_API_KEY}" },
      },
    },
  },
}
```

The setting accepts a secret string or a standard SecretRef. Resolve it through
OpenClaw's normal configuration and secret preparation before running a turn.
When present, this credential owns Agents API authentication: a missing or
unresolved value fails without selecting an OpenAI provider key or auth profile.
The OpenAI provider still supplies model metadata. Its Responses API credential,
adapter and endpoint remain independent. Agents API uses the official SDK's
endpoint and has no URL setting.

Omitting this setting preserves existing OpenAI API-key authentication for
configurations created before the dedicated setting was available.

Token accounting reads canonical native turn records after settlement, since
completion stream events can omit usage. Each OpenClaw attempt counts its new
coordinator turns once, including work superseded by steering. Earlier turns in
the same native session are excluded. Cached input is counted separately from
uncached input; reasoning tokens remain included in output tokens.

Successful assistant messages retain those totals in the OpenClaw transcript.
Run results and completion hooks also retain usage reported for interrupted or
failed work after native cleanup settles. Historical session usage is derived
from transcript messages, so interrupted work without an assistant message is
not included in that historical report. A bounded five-second settlement window
waits for late turn records and usage. Counts are not refreshed after that
snapshot. Accounting read failures retain the last available snapshot and log a
warning; they do not discard a completed reply or replace cancellation. Missing
native usage remains unavailable; native counts can change as
upstream accounting arrives. See the
[official usage guide](https://developers.openai.com/api/docs/guides/agents-api/observability).

Native turn billing can sum multiple model calls. It does not establish the
current context-window usage. Cost estimates use the configured model prices;
they are not provider billing receipts.
