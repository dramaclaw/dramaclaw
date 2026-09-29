// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { MEDIA_VARIANT_MAX_EDGE, pickMediaVariant, type MediaVariant } from '@/lib/media-url';

/** Upgrade as soon as needed; require spare capacity before downgrading. */
export function chooseStableCanvasTier(previous: MediaVariant | null | undefined, requiredEdge: number): MediaVariant | null {
  const requested = pickMediaVariant(requiredEdge);
  if (previous === undefined || !Number.isFinite(requiredEdge) || requiredEdge <= 0) return requested;
  const capacity = previous === null ? Infinity : MEDIA_VARIANT_MAX_EDGE[previous];
  if (requiredEdge > capacity) return requested;
  const lower = pickMediaVariant(requiredEdge / 0.8);
  return lower !== null && MEDIA_VARIANT_MAX_EDGE[lower] < capacity ? lower : previous;
}
