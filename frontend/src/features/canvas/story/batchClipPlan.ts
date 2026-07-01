import { isVideoNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

export interface MissingClip {
  id: string;
  /** 文生视频提示词 = 节点旁白。 */
  prompt: string;
}

export interface MissingClipPlan {
  /** 可生成的缺失片段(有旁白)。 */
  generable: MissingClip[];
  /** 跳过的缺失片段 id(无旁白,无可用提示词)。 */
  skipped: string[];
}

/**
 * 收集某故事组的缺失片段:组内、视频类型、无 `videoUrl`、且未在生成中的节点。
 * 有非空 `narration` → generable(prompt=旁白);否则 → skipped。
 */
export function collectMissingStoryClips(
  nodes: CanvasNode[],
  groupId: string,
): MissingClipPlan {
  const generable: MissingClip[] = [];
  const skipped: string[] = [];
  for (const node of nodes) {
    if (node.parentId !== groupId || !isVideoNode(node)) continue;
    const data = node.data as { videoUrl?: string | null; narration?: string; isGenerating?: boolean };
    if (data.videoUrl) continue;
    if (data.isGenerating) continue;
    const prompt = (data.narration ?? '').trim();
    if (prompt) generable.push({ id: node.id, prompt });
    else skipped.push(node.id);
  }
  return { generable, skipped };
}

/**
 * 限并发执行:`items` 逐个过 `worker`,任一时刻最多 `limit` 个并行。
 * 返回与输入同序的 settled 结果;某项抛错记为 rejected,不中断其余。
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const max = Math.max(1, Math.floor(limit));
  let next = 0;

  async function runner(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(max, items.length) }, () => runner()));
  return results;
}
