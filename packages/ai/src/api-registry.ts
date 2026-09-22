import {
  inheritModelRequestBinding,
  type ModelRequestBindingSupport,
  type Api,
  type AssistantMessageEventStreamContract,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type StreamOptions,
} from "@openclaw/llm-core";

/** Runtime stream adapter signature stored in the API provider registry. */
export type ApiStreamFunction = ((
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStreamContract) &
  ModelRequestBindingSupport;

/** Runtime simple-stream adapter signature stored in the API provider registry. */
export type ApiStreamSimpleFunction = ((
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStreamContract) &
  ModelRequestBindingSupport;

/** Provider implementation registered by core or plugins for a specific model API. */
export interface ApiProvider<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> {
  /** Model API id this provider handles. */
  api: TApi;
  /** Full streaming adapter for callers that already own structured options. */
  stream: StreamFunction<TApi, TOptions>;
  /** Simple streaming adapter used by agent and plugin runtime defaults. */
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

/** Type-erased provider returned by a registry after API guards are installed. */
export interface RegisteredApiProvider {
  api: Api;
  stream: ApiStreamFunction;
  streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProviderEntry = {
  provider: RegisteredApiProvider;
  sourceId?: string;
};

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
  api: TApi,
  stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
  return inheritModelRequestBinding<ApiStreamFunction>((model, context, options) => {
    if (model.api !== api) {
      throw new Error(`Mismatched api: ${model.api} expected ${api}`);
    }
    return stream(model as Model<TApi>, context, options as TOptions);
  }, stream);
}

function wrapStreamSimple<TApi extends Api>(
  api: TApi,
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
  return inheritModelRequestBinding<ApiStreamSimpleFunction>((model, context, options) => {
    if (model.api !== api) {
      throw new Error(`Mismatched api: ${model.api} expected ${api}`);
    }
    return streamSimple(model as Model<TApi>, context, options);
  }, streamSimple);
}

/** Creates an isolated provider registry for one runtime or tenant. */
export function createApiRegistry() {
  const providers = new Map<string, RegisteredApiProviderEntry>();

  function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
    provider: ApiProvider<TApi, TOptions>,
    /** Optional source id used to unregister all providers owned by one plugin/runtime. */
    sourceId?: string,
  ): void {
    providers.set(provider.api, {
      provider: {
        api: provider.api,
        stream: wrapStream(provider.api, provider.stream),
        streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
      },
      sourceId,
    });
  }

  function getApiProvider(api: Api): RegisteredApiProvider | undefined {
    return providers.get(api)?.provider;
  }

  function getApiProviders(): RegisteredApiProvider[] {
    return Array.from(providers.values(), (entry) => entry.provider);
  }

  function unregisterApiProviders(sourceId: string): void {
    for (const [api, entry] of providers.entries()) {
      if (entry.sourceId === sourceId) {
        providers.delete(api);
      }
    }
  }

  return {
    registerApiProvider,
    getApiProvider,
    getApiProviders,
    unregisterApiProviders,
    clearApiProviders: () => providers.clear(),
  };
}

export type ApiRegistry = ReturnType<typeof createApiRegistry>;
