// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from 'react';
import { listDirectorBatches, type DirectorMediaBatch } from '@/api/director';
import { listTasks } from '@/api/tasks';
import { fetchFreezoneJobResult } from '@/api/ops';
import { resolveMediaUrl } from '@/lib/media-url';

/** Canvas results outlive the planning panel. Polling is read-only. */
export function useDirectorMedia(project: string, work: string) {
  const [batches, setBatches] = useState<DirectorMediaBatch[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, { status: string; url?: string }>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const done = new Map<string, { status: string; url?: string }>();
    setBatches([]); setOutcomes({}); setError('');
    const poll = async () => {
      try {
        const next = await listDirectorBatches(project, work);
        if (!active) return;
        setBatches(next); setError('');
        const accepted = next.flatMap(b => b.nodes).filter(n => n.intent.status === 'accepted');
        const tasks = accepted.some(n => !done.has(n.id)) ? await listTasks(project) : [];
        for (const node of accepted) {
          if (!active || done.has(node.id)) continue;
          const receipt = node.intent.result;
          const task = tasks.find(t => t.task_key === receipt.task_key);
          let url: string | undefined;
          if ((!task || task.status === 'completed') && receipt.job_id) {
            try { url = resolveMediaUrl((await fetchFreezoneJobResult(project, 'freezone_gen', receipt.job_id)).url) ?? undefined; }
            catch { /* A result missing from a live queue may still become durable later. */ }
          }
          const result = { status: url ? 'completed' : task?.status ?? 'accepted', url };
          if (url || ['failed', 'cancelled'].includes(result.status)) done.set(node.id, result);
          if (active) setOutcomes(value => ({ ...value, [node.id]: result }));
        }
      } catch (reason) { if (active) setError(String(reason)); }
      if (active) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [project, work]);
  return { batches, outcomes, error };
}
