import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  collectMissingStoryClips,
  runWithConcurrency,
} from '@/features/canvas/story/batchClipPlan';

function vnode(
  id: string,
  data: Record<string, unknown>,
  parentId = 'g',
): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.video, parentId, position: { x: 0, y: 0 }, data } as CanvasNode;
}

describe('collectMissingStoryClips', () => {
  it('仅准备好独立视频提示词的缺失片段可生成', () => {
    const nodes = [
      { id: 'g', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
      vnode('a', { videoUrl: null, narration: '玩家选择寻找钥匙或离开', prompt: '  深夜寝殿，主角推门未开，中景停留  ' }),
      vnode('b', { videoUrl: null, narration: '有剧情但没有制作提示词', prompt: '  ' }),
      vnode('c', { videoUrl: null, storyProductionNotes: '结尾停留' }),
    ] as CanvasNode[];
    const plan = collectMissingStoryClips(nodes, 'g');
    expect(plan.generable).toEqual([{ id: 'a', prompt: '深夜寝殿，主角推门未开，中景停留' }]);
    expect(plan.skipped.sort()).toEqual(['b', 'c']);
  });

  it('无需旁白也可以生成；忽略损坏的提示词类型', () => {
    const plan = collectMissingStoryClips([
      vnode('a', { prompt: '雨滴落在木门上' }),
      vnode('b', { prompt: 123, narration: '不能回退为此内容' }),
    ], 'g');
    expect(plan.generable).toEqual([{ id: 'a', prompt: '雨滴落在木门上' }]);
    expect(plan.skipped).toEqual(['b']);
  });

  it('有视频 / 生成中 / 非组成员 / 非视频 → 都不收', () => {
    const nodes = [
      vnode('hasVideo', { videoUrl: 'x.mp4', prompt: '有' }),
      vnode('busy', { videoUrl: null, prompt: '生成中', isGenerating: true }),
      vnode('other', { videoUrl: null, prompt: '别组' }, 'other-group'),
      { id: 'img', type: CANVAS_NODE_TYPES.imageGen, parentId: 'g', position: { x: 0, y: 0 }, data: { imageUrl: null } },
    ] as CanvasNode[];
    const plan = collectMissingStoryClips(nodes, 'g');
    expect(plan.generable).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('runWithConcurrency', () => {
  it('并发不超过 limit,全部执行,保留顺序与结果', async () => {
    let active = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const results = await runWithConcurrency(items, 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('某项抛错 → 该项 rejected,不中断其余', async () => {
    const results = await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
