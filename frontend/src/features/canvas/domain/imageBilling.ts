export interface ImageBillingModelIdentity {
  catalogId?: string;
  apiModel?: string;
}

export function buildImageFeatureBillingParams(
  model: ImageBillingModelIdentity | null | undefined,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const catalogId = String(model?.catalogId ?? "").trim();
  const apiModel = String(model?.apiModel ?? "").trim();
  return {
    ...params,
    ...(apiModel ? { image_selection: apiModel } : {}),
    ...(catalogId
      ? {
          catalog_id: catalogId,
          ...(apiModel ? { pricing_model: apiModel } : {}),
        }
      : {}),
  };
}
