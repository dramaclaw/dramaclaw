// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from "react";

import {
  fetchCanvasGenerationHistory,
  fetchNodeGenerationHistory,
  type FreezoneGenerationHistoryRecord,
} from "@/api/ops";
import { ApiError } from "@/api/client";
import { readUrl } from "@/lib/url-params";

export interface UseCanvasGenerationHistoryResult {
  records: FreezoneGenerationHistoryRecord[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/** Fan-out concurrency cap for the per-node fallback. */
const FANOUT_CONCURRENCY = 6;

function sortNewestFirst(
  records: FreezoneGenerationHistoryRecord[],
): FreezoneGenerationHistoryRecord[] {
  return [...records].sort(
    (a, b) =>
      new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
  );
}

/**
 * Legacy per-node aggregation: one request per live node id (capped
 * concurrency), merged + deduped + sorted newest-first. Used only as a fallback
 * when the backend lacks the canvas-level aggregate endpoint (older deploy).
 */
async function aggregatePerNode(
  project: string,
  canvasId: string,
  nodeIds: string[],
): Promise<FreezoneGenerationHistoryRecord[]> {
  const out: FreezoneGenerationHistoryRecord[] = [];
  for (let i = 0; i < nodeIds.length; i += FANOUT_CONCURRENCY) {
    const slice = nodeIds.slice(i, i + FANOUT_CONCURRENCY);
    const batches = await Promise.all(
      slice.map((nodeId) =>
        fetchNodeGenerationHistory(project, canvasId, nodeId).catch(() => []),
      ),
    );
    for (const batch of batches) out.push(...batch);
  }
  const seen = new Set<string>();
  return sortNewestFirst(
    out.filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    }),
  );
}

/**
 * Read the whole canvas's generation history for the history-assets modal.
 *
 * Prefers the canvas-level aggregate endpoint, which merges every node that
 * ever recorded history on this canvas — including nodes since deleted from the
 * canvas — so deleting a node no longer drops its past generations from the
 * browser.
 *
 * `fallbackNodeIds` are the live canvas node ids used ONLY when the backend does
 * not yet expose the aggregate route (404 during a frontend-ahead-of-backend
 * deploy). In that window we fall back to the old per-node fan-out so existing
 * users' history still shows (minus deleted nodes — the pre-existing behavior).
 * Once the backend ships the route, deleted-node history is recovered too.
 *
 * History lives outside the canvas JSON, so this is a plain on-demand fetch
 * gated by `enabled` (the modal only mounts when opened).
 */
export function useCanvasGenerationHistory(
  fallbackNodeIds: string[],
  options?: { enabled?: boolean },
): UseCanvasGenerationHistoryResult {
  const enabled = options?.enabled ?? true;
  const [records, setRecords] = useState<FreezoneGenerationHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Snapshot the ids as a stable string so the callback identity only changes
  // when the actual id set changes (not on every nodes-array reference churn).
  const nodeIdsKey = fallbackNodeIds.join(",");

  const refresh = useCallback(async () => {
    const project = readUrl().project;
    if (!project) return;
    const canvasId = readUrl().canvas ?? "default";
    setIsLoading(true);
    try {
      let recs: FreezoneGenerationHistoryRecord[];
      try {
        recs = await fetchCanvasGenerationHistory(project, canvasId);
      } catch (err) {
        // Backend without the aggregate route (older deploy) → 404. Fall back to
        // the per-node fan-out so history still shows during version skew.
        if (err instanceof ApiError && err.status === 404) {
          const ids = nodeIdsKey ? nodeIdsKey.split(",") : [];
          recs = await aggregatePerNode(project, canvasId, ids);
        } else {
          throw err;
        }
      }
      setRecords(recs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [nodeIdsKey]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { records, isLoading, error, refresh };
}
