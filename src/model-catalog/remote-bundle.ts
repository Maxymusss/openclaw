import {
  validateAndSanitizeRemoteModelCatalogBundle,
  validateAndSanitizeRemoteModelCatalogBundleV2,
  type RemoteModelCatalogBundle,
  type RemoteModelCatalogBundleV2,
} from "@openclaw/model-catalog-core";
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type {
  ModelCatalogCost,
  ModelCatalogProvider,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type RemoteModelCatalogWireBundle = RemoteModelCatalogBundle | RemoteModelCatalogBundleV2;
export type RemoteModelCatalogPrice = { cost: ModelCatalogCost; explicit: boolean };

/** Configured v1 mirrors remain a public input contract; runtime uses one projection. */
export function parseRemoteModelCatalogWireBundle(value: unknown): RemoteModelCatalogWireBundle {
  return isRecord(value) && value.schemaVersion === 2
    ? validateAndSanitizeRemoteModelCatalogBundleV2(value)
    : validateAndSanitizeRemoteModelCatalogBundle(value);
}

export function projectRemoteModelCatalog(bundle: RemoteModelCatalogWireBundle): {
  providers: Record<string, ModelCatalogProvider>;
  pricing: Record<string, RemoteModelCatalogPrice>;
} {
  if (bundle.schemaVersion === 1) {
    return {
      providers: bundle.providers,
      pricing: Object.fromEntries(
        Object.entries(bundle.pricing ?? {}).map(([key, cost]) => [key, { cost, explicit: false }]),
      ),
    };
  }
  const providers: Record<string, ModelCatalogProvider> = Object.fromEntries(
    Object.entries(bundle.providers).map(([id, provider]) => [id, { ...provider, models: [] }]),
  );
  const prices: Array<[string, RemoteModelCatalogPrice]> = [];
  for (const { provider, pricing, ...model } of bundle.models) {
    let cost: ModelCatalogCost | undefined;
    if (pricing.status === "known") {
      const {
        status: _status,
        currency: _currency,
        unit: _unit,
        source: _source,
        ...rates
      } = pricing;
      cost = rates;
      prices.push([buildModelCatalogRef(provider, model.id), { cost, explicit: true }]);
    }
    // Keep unknown/withdrawn rows: replacing the manifest row also withdraws its stale cost.
    // SAFETY: the v2 schema requires every model provider to be declared in bundle.providers.
    providers[provider]!.models.push({ ...model, ...(cost ? { cost } : {}) });
  }
  return { providers, pricing: Object.fromEntries(prices) };
}
