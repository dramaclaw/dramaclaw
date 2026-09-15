// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type ProductSurfaceCode =
  | "mainline"
  | "freezone"
  | "assistant"
  | "freezone_assistant"
  | "payment";

export interface ProductSurfaceAccess {
  surface_code: ProductSurfaceCode;
  label: string;
  available: boolean;
  unavailable_message: string;
}

export function useProductSurfaces(enabled = true) {
  return useQuery({
    queryKey: queryKeys.productSurfaces(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/product-surfaces/me", { signal, retry: 0 })
        .json<OkResponse<{ items: ProductSurfaceAccess[] }>>(),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function surfaceAccess(
  data: OkResponse<{ items: ProductSurfaceAccess[] }> | undefined,
  surfaceCode: ProductSurfaceCode,
): ProductSurfaceAccess | undefined {
  return data?.data.items.find((item) => item.surface_code === surfaceCode);
}
