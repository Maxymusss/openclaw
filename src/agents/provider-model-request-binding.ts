import type { ModelRequestBindingLeafSupport } from "@openclaw/ai";
import { inheritModelRequestBinding, type ModelRequestBindingSupport } from "@openclaw/llm-core";
import {
  providerModelRequestBindingHookSupported,
  readProviderModelRequestBindingDeclaration,
  providerModelRequestBindingSupported,
} from "../plugins/provider-model-request-binding.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import type {
  ProviderModelRequestBindingContext,
  ProviderModelRequestBindingResult,
  ProviderWrapStreamFnContext,
} from "../plugins/provider-transport.types.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.js";
import {
  assertOperatorModelAllowed,
  OperatorModelPolicyError,
  requireOperatorModelDelegateSupport,
  runWithOperatorModelRequest,
} from "./operator-model-policy.js";
import type { StreamFn } from "./runtime/index.js";

type BindingParams = ProviderModelRequestBindingContext & {
  plugin?: ProviderPlugin;
  authority?: AdmittedRunOperatorAuthority;
  isCurrent?: () => boolean;
};

function assertBinding(params: BindingParams, supported: () => boolean): boolean {
  return runWithOperatorModelRequest(params.authority, (original) => {
    assertOperatorModelAllowed(original, params.model.provider, params.model.id);
    if (!original?.permissions?.models) {
      return false;
    }
    if (params.isCurrent?.() === false || !supported()) {
      throw new OperatorModelPolicyError(
        "The selected provider route cannot enforce your model restrictions. Choose a provider route and transport that support them.",
      );
    }
    return true;
  });
}

export function assertProviderModelRequestBindingHook(
  params: BindingParams & {
    hook: keyof ProviderModelRequestBindingResult;
  },
): boolean {
  return assertBinding(params, () =>
    providerModelRequestBindingHookSupported(
      params,
      readProviderModelRequestBindingDeclaration(params),
    ),
  );
}

export function assertProviderModelRequestBinding(
  params: BindingParams & {
    leaf?: ModelRequestBindingLeafSupport;
    wrapper?: "wrapStreamFn" | "wrapSimpleCompletionStreamFn";
  },
): boolean {
  return assertBinding(params, () => providerModelRequestBindingSupported(params));
}

/** An opted-in factory cannot silently fall through or return an unqualified delegate. */
export function assertProviderModelRequestBindingResult(
  finite: boolean,
  stream: ModelRequestBindingSupport | null | undefined,
): void {
  if (finite && stream?.modelRequestBinding !== "wire-model-v1") {
    throw new OperatorModelPolicyError(
      "The provider returned no qualified model request delegate.",
    );
  }
}

/** Cached registrations borrow the invoking source; construction never captures a guest. */
export function guardProviderModelRequestBinding(
  stream: StreamFn,
  params: Omit<BindingParams, "authority"> & {
    leaf?: ModelRequestBindingLeafSupport;
    wrapper?: "wrapStreamFn" | "wrapSimpleCompletionStreamFn";
  },
): StreamFn {
  return inheritModelRequestBinding<StreamFn>((model, context, options) => {
    assertProviderModelRequestBinding({
      ...params,
      model,
      transport: options?.transport ?? params.transport,
    });
    return stream(model, context, options);
  }, stream);
}

/** Only a declared wrapper may be constructed for a finite caller. Returned functions retain their own contract. */
export function constructProviderModelStreamWrapper(params: {
  plugin?: ProviderPlugin;
  context: ProviderWrapStreamFnContext;
  hook: "wrapStreamFn" | "wrapSimpleCompletionStreamFn";
  transport: ProviderModelRequestBindingContext["transport"];
  authority?: AdmittedRunOperatorAuthority;
  isCurrent?: () => boolean;
}): StreamFn | undefined {
  return runWithOperatorModelRequest(params.authority, () => {
    const wrap = params.plugin?.[params.hook];
    if (!wrap) {
      return undefined;
    }
    const model = params.context.model;
    if (!model) {
      requireOperatorModelDelegateSupport(undefined);
    }
    const finite = model
      ? assertProviderModelRequestBindingHook({
          ...params,
          model: params.context.sourceApi ? { ...model, api: params.context.sourceApi } : model,
        })
      : false;
    const wrapped = wrap.call(params.plugin, params.context) ?? undefined;
    if (wrapped) {
      assertProviderModelRequestBindingResult(finite, wrapped);
    }
    if (wrapped === params.context.streamFn) {
      return wrapped;
    }
    return (
      wrapped &&
      inheritModelRequestBinding<StreamFn>((runtimeModel, context, options) => {
        assertProviderModelRequestBindingHook({
          ...params,
          model: params.context.sourceApi
            ? { ...runtimeModel, api: params.context.sourceApi }
            : runtimeModel,
          transport: options?.transport ?? params.transport,
        });
        return wrapped(runtimeModel, context, options);
      }, wrapped)
    );
  });
}
