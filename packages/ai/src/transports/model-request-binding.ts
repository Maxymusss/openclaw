import type { Model } from "@openclaw/llm-core";
import { getAiTransportHost } from "../host.js";

function payloadModel(payload: object): string | undefined {
  const field = Object.getOwnPropertyDescriptor(payload, "model");
  // A getter or custom JSON serializer does not prove which model the SDK sends.
  return field && "value" in field && typeof field.value === "string" && !("toJSON" in payload)
    ? field.value
    : undefined;
}

/** Finite requests own routing fields across hooks and SDK awaits; ordinary hooks stay unchanged. */
export function prepareModelRequest<T extends Model>(canonical: T, resolve?: (model: T) => T) {
  const host = getAiTransportHost();
  const authority = host.modelRequests?.capture(canonical);
  const cloneModel = (model: T): T => {
    // SAFETY: The host copies transport facts onto an otherwise identical typed model.
    return host.inheritManagedTransport(model, { ...model }) as T;
  };
  const source = authority ? cloneModel(canonical) : canonical;
  const resolved = resolve?.(source) ?? source;
  const model = authority ? Object.freeze(cloneModel(resolved)) : resolved;
  const hookModel = authority ? host.inheritManagedTransport(model, { ...model }) : model;
  let validate: ReturnType<NonNullable<typeof authority>["bindWireModel"]> | undefined;
  return {
    model,
    hookModel,
    assertCurrent: authority ? () => authority.assertCurrent() : undefined,
    preparePayload(payload: object) {
      if (authority) {
        validate ??= authority.bindWireModel(payloadModel(payload), model);
        validate(hookModel, payloadModel(payload));
      }
    },
    acceptPayload<P extends object>(this: void, payload: P): P {
      if (!authority) {
        return payload;
      }
      const fields = Object.getOwnPropertyDescriptors(payload);
      const wireModel = Object.values(fields).every((field) => "value" in field)
        ? payloadModel(payload)
        : undefined;
      validate?.(hookModel, wireModel);
      // Copy first: other property getters must not mutate routing after validation.
      const owned = { ...payload, model: wireModel };
      Object.defineProperty(owned, "model", {
        value: wireModel,
        writable: false,
        configurable: false,
      });
      validate?.(hookModel, wireModel);
      if (!validate) {
        authority.bindWireModel(undefined, model);
      }
      return owned;
    },
  };
}
