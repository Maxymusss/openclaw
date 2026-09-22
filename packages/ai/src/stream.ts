import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
} from "@openclaw/llm-core";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import { getAiTransportHost } from "./host.js";

/** Creates an isolated LLM runtime backed by the supplied provider registry. */
export function createLlmRuntime(registry: ApiRegistry = createApiRegistry()) {
  function resolveApiProvider(api: Api) {
    const provider = registry.getApiProvider(api);
    if (!provider) {
      throw new Error(`No API provider registered for api: ${api}`);
    }
    return provider;
  }

  function stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ProviderStreamOptions,
  ): AssistantMessageEventStreamContract {
    const delegate = resolveApiProvider(model.api).stream;
    getAiTransportHost().modelRequests?.requireDelegateSupport(delegate.modelRequestBinding);
    return delegate(model, context, options as StreamOptions);
  }

  async function complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage> {
    return stream(model, context, options).result();
  }

  function streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStreamContract {
    const delegate = resolveApiProvider(model.api).streamSimple;
    getAiTransportHost().modelRequests?.requireDelegateSupport(delegate.modelRequestBinding);
    return delegate(model, context, options);
  }

  async function completeSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return streamSimple(model, context, options).result();
  }

  // Dispatchers qualify by checking the current registration on every invocation.
  return {
    registry,
    stream: Object.assign(stream, { modelRequestBinding: "wire-model-v1" as const }),
    complete,
    streamSimple: Object.assign(streamSimple, { modelRequestBinding: "wire-model-v1" as const }),
    completeSimple,
  };
}

export type LlmRuntime = ReturnType<typeof createLlmRuntime>;
