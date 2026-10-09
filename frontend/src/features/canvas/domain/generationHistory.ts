// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';

export function isCompletedGeneration(record: Pick<FreezoneGenerationHistoryRecord, 'status'>): boolean {
  return record.status === 'completed' || record.status === 'succeeded';
}

/** Probe the output keys shared by generation endpoints, without UI dependencies. */
export function historyRecordOutputUrl(record: FreezoneGenerationHistoryRecord): string | null {
  const result = record.result ?? {};
  for (const key of ['output_url', 'image_url', 'video_url', 'audio_url', 'ply_url', 'master_url', 'url']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
