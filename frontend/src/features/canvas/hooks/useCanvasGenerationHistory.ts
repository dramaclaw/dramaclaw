// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from "react";

import {
  fetchCanvasGenerationHistory,
  type FreezoneGenerationHistoryRecord,
} from "@/api/ops";
import { readUrl } from "@/lib/url-params";

export interface UseCanvasGenerationHistoryResult {
  records: FreezoneGenerationHistoryRecord[];
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Read the whole canvas's generation history for the history-assets modal.
 *
 * The backend aggregates across every node that ever recorded history on this
 * canvas — including nodes since deleted from the canvas — so deleting a node
 * no longer drops its past generations from the history browser. History lives
 * outside the canvas JSON, so this is a plain on-demand fetch gated by
 * `enabled` (the modal only mounts when opened).
 */
export function useCanvasGenerationHistory(
  options?: { enabled?: boolean },
): UseCanvasGenerationHistoryResult {
  const enabled = options?.enabled ?? true;
  const [records, setRecords] = useState<FreezoneGenerationHistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    const project = readUrl().project;
    if (!project) return;
    const canvasId = readUrl().canvas ?? "default";
    setIsLoading(true);
    try {
      const recs = await fetchCanvasGenerationHistory(project, canvasId);
      setRecords(recs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { records, isLoading, error, refresh };
}
