// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Read both legacy single-image results and workflow candidate batches. */
export function imageGenerationResultUrls(
  result: Record<string, unknown> | null | undefined,
): string[] {
  if (!result) return [];
  const primary = [result.output_url, result.image_url, result.url]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set([
    ...(primary ? [primary] : []),
    ...(Array.isArray(result.output_urls) ? result.output_urls : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
