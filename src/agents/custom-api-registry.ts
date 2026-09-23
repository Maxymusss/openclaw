/**
 * Registers caller-supplied custom API stream functions with the LLM registry.
 */
import type { ApiRegistry, ModelRequestBindingLeafSupport } from "@openclaw/ai";
import {
  inheritModelRequestBinding,
  type StreamFunction,
  type SimpleStreamOptions,
  type StreamFn,
} from "@openclaw/llm-core";
import type {
  Api,
  AssistantMessageEventStreamContract,
  Model,
  StreamOptions,
} from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { runPluginStreamConsumer } from "../plugins/plugin-instance-scope.js";
import { isOperatorModelPolicyError } from "./operator-model-policy.js";
import { buildStreamErrorAssistantMessage } from "./stream-message-shared.js";

const CUSTOM_API_SOURCE_PREFIX = "openclaw-custom-api:";

/** Returns the registry source id used for a custom API stream function. */
function getCustomApiRegistrySourceId(api: Api): string {
  return `${CUSTOM_API_SOURCE_PREFIX}${api}`;
}

function adaptCustomStream(
  model: Model,
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (!(stream instanceof Promise)) {
    return stream as AssistantMessageEventStreamContract;
  }

  const adapted = createAssistantMessageEventStream();
  void (async () => {
    try {
      // Registry providers must return a stream immediately, while plugin
      // hooks may resolve one lazily. Bridge that lifecycle at the boundary.
      await runPluginStreamConsumer(stream, async () => {
        const resolved = await stream;
        for await (const event of resolved) {
          adapted.push(event);
        }
        adapted.end(await resolved.result());
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const message = buildStreamErrorAssistantMessage({ model, errorMessage });
      if (isOperatorModelPolicyError(error)) {
        message.errorCode = "OPERATOR_MODEL_POLICY_DENIED";
      }
      adapted.push({ type: "error", reason: "error", error: message });
    }
  })();
  return adapted;
}

/** Registers a custom API stream function when no provider already owns it. */
export function ensureCustomApiRegistered(
  registry: ApiRegistry,
  api: Api,
  streamFn: StreamFn,
  support?: ModelRequestBindingLeafSupport,
): boolean {
  if (registry.getApiProvider(api)) {
    return false;
  }

  registry.registerApiProvider(
    {
      api,
      ...(support
        ? { modelRequestBindingSupport: { stream: support, streamSimple: support } }
        : {}),
      stream: inheritModelRequestBinding<StreamFunction>(
        (model, context, options) => adaptCustomStream(model, streamFn(model, context, options)),
        streamFn,
      ),
      streamSimple: inheritModelRequestBinding<StreamFunction<Api, SimpleStreamOptions>>(
        (model, context, options) =>
          adaptCustomStream(model, streamFn(model, context, options as StreamOptions)),
        streamFn,
      ),
    },
    getCustomApiRegistrySourceId(api),
  );
  return true;
}
