import type { LlmRuntime } from "@openclaw/ai";
import type { ProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { Model, SimpleStreamOptions } from "./types.js";

const MODEL_LLM_RUNTIME = Symbol("openclaw.modelLlmRuntime");
const MODEL_REQUEST_ROUTE = Symbol("openclaw.modelRequestRoute");
const streamLlmRuntimes = new WeakMap<object, LlmRuntime>();

type ModelCompletionOwner = {
  run: <T>(run: () => Promise<T>) => Promise<T>;
  assertCurrent: () => void;
};

type ModelRuntimeBinding = {
  runtime?: LlmRuntime;
  completionTransport?: Model;
  completionTransportKind?: SimpleStreamOptions["transport"];
  completionOwner?: ModelCompletionOwner;
};

type RuntimeBoundModel = Model & {
  [MODEL_LLM_RUNTIME]?: ModelRuntimeBinding;
  [MODEL_REQUEST_ROUTE]?: Readonly<{
    logicalRef: Readonly<ProviderModelRef>;
    routes: readonly Readonly<Pick<Model, "provider" | "id" | "api" | "baseUrl">>[];
  }>;
};

function modelRoute(model: Model) {
  return Object.freeze({
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
  });
}

function modelRequestRoute(model: Model, logicalRef: ProviderModelRef) {
  return Object.freeze({
    logicalRef: Object.freeze({ ...logicalRef }),
    routes: Object.freeze([modelRoute(model)]),
  });
}

/** Host resolution owns the logical identity; provider callbacks cannot supply it. */
export function bindModelRequestRoute<T extends RuntimeBoundModel>(
  model: T,
  logicalRef: ProviderModelRef,
): T {
  const bound = {
    ...model,
    [MODEL_REQUEST_ROUTE]: modelRequestRoute(model, logicalRef),
  };
  const runtime = model[MODEL_LLM_RUNTIME];
  if (runtime) {
    Object.defineProperty(bound, MODEL_LLM_RUNTIME, { value: runtime, enumerable: false });
  }
  return bound;
}

/** Canonical transport projections add their API alias before invocation captures the route. */
export function inheritModelRequestRoute<T extends Model>(source: RuntimeBoundModel, target: T): T {
  // Raw callers still get a host-owned self selection before a transport API alias.
  const selection =
    source[MODEL_REQUEST_ROUTE] ??
    modelRequestRoute(source, {
      provider: source.provider,
      model: source.id,
    });
  const known = selection.routes.some(
    (route) =>
      route.provider === target.provider &&
      route.id === target.id &&
      route.api === target.api &&
      route.baseUrl === target.baseUrl,
  );
  return {
    ...target,
    [MODEL_REQUEST_ROUTE]: known
      ? selection
      : Object.freeze({
          logicalRef: selection.logicalRef,
          routes: Object.freeze([...selection.routes, modelRoute(target)]),
        }),
  };
}

export function readModelRequestRoute(model: object) {
  // SAFETY: Only this module's host routing writers can create the private symbol.
  return (model as RuntimeBoundModel)[MODEL_REQUEST_ROUTE];
}

function bindModelRuntime(model: Model, binding: ModelRuntimeBinding): Model {
  const bound: RuntimeBoundModel = { ...model };
  Object.defineProperty(bound, MODEL_LLM_RUNTIME, {
    value: binding,
    enumerable: false,
  });
  return bound;
}

/** Carries the prepared lifecycle runtime without changing the serialized model shape. */
export function bindModelLlmRuntime(
  model: Model,
  runtime: LlmRuntime,
  completionTransport?: Model,
  completionTransportKind?: SimpleStreamOptions["transport"],
): Model {
  return bindModelRuntime(model, {
    runtime,
    completionTransport,
    completionTransportKind,
    completionOwner: getModelCompletionOwner(model),
  });
}

export function bindModelCompletionOwner(
  model: RuntimeBoundModel,
  completionOwner: ModelCompletionOwner,
): Model {
  return bindModelRuntime(model, { ...model[MODEL_LLM_RUNTIME], completionOwner });
}

export function getModelCompletionOwner(
  model: RuntimeBoundModel,
): ModelCompletionOwner | undefined {
  return model[MODEL_LLM_RUNTIME]?.completionOwner;
}

export function getModelLlmRuntime(model: RuntimeBoundModel): LlmRuntime | undefined {
  return model[MODEL_LLM_RUNTIME]?.runtime;
}

export function getModelCompletionTransport(model: RuntimeBoundModel): Model | undefined {
  return model[MODEL_LLM_RUNTIME]?.completionTransport;
}

export function getModelCompletionTransportKind(
  model: RuntimeBoundModel,
): SimpleStreamOptions["transport"] {
  return model[MODEL_LLM_RUNTIME]?.completionTransportKind;
}

/** Associates a prepared stream entry point with the runtime that owns it. */
export function bindStreamLlmRuntime(streamFn: object, runtime: LlmRuntime): void {
  streamLlmRuntimes.set(streamFn, runtime);
}

export function getStreamLlmRuntime(streamFn: object | undefined): LlmRuntime | undefined {
  return streamFn ? streamLlmRuntimes.get(streamFn) : undefined;
}
