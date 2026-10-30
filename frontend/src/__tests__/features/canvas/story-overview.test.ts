// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { buildStoryOverview } from '@/features/canvas/story/storyOverview';

function groupNode(overrides: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'g1',
    type: CANVAS_NODE_TYPES.group,
    position: { x: 0, y: 0 },
    data: {
      displayName: '雨夜出租车',
      storyGroup: true,
      interactiveStoryId: 'story-1',
      storySynopsis: '司机接到一位自称来自十年前的乘客。',
      storyCharacters: [{ id: 'lin', name: '小琳', description: '神秘乘客' }],
      ...overrides,
    },
  } as unknown as CanvasNode;
}

function segment(
  id: string,
  opts: {
    start?: boolean;
    narration?: string;
    prompt?: string;
    notes?: string;
    ending?: string;
    video?: string | null;
  } = {},
): CanvasNode {
  return {
    id,
    parentId: 'g1',
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      displayName: id,
      videoUrl: opts.video === undefined ? 'v.mp4' : opts.video,
      aspectRatio: '16:9',
      ...(opts.start ? { storyRole: 'start' as const } : {}),
      ...(opts.narration ? { narration: opts.narration } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.notes ? { storyProductionNotes: opts.notes } : {}),
      ...(opts.ending ? { endingLabel: opts.ending } : {}),
    },
  } as unknown as CanvasNode;
}

function choice(source: string, target: string, choiceText: string, order: number): CanvasEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText, order },
  } as CanvasEdge;
}

describe('buildStoryOverview', () => {
  it('projects synopsis, characters and readable script copy from the canvas', () => {
    const nodes = [
      groupNode(),
      segment('a', { start: true, narration: '雨夜，路边拦下一辆车。', notes: '冷色调镜头' }),
      segment('b', { narration: '乘客报出一个十年前的地址。', prompt: 'VIDEO PROMPT MUST NOT LEAK' }),
      segment('c', { narration: '司机在加油站做出的选择。', ending: 'GE' }),
    ];
    const edges = [choice('a', 'b', '回头看她', 0), choice('b', 'c', '下车', 0)];
    const overview = buildStoryOverview('g1', nodes, edges)!;

    expect(overview.title).toBe('雨夜出租车');
    expect(overview.synopsis).toContain('十年前');
    expect(overview.characters.map((c) => c.name)).toEqual(['小琳']);
    expect(overview.segmentCount).toBe(3);
    expect(overview.scriptReadyCount).toBe(3);
    // 剧情文案与视频提示词严格分离：总览里只有 narration 与制作备注。
    expect(overview.segmentsById.get('b')?.script).toBe('乘客报出一个十年前的地址。');
    expect(JSON.stringify([...overview.segmentsById.values()])).not.toContain('MUST NOT LEAK');
    expect(overview.segmentsById.get('a')?.productionNotes).toBe('冷色调镜头');
    // 分支树从起点展开，结局单列。
    expect(overview.tree.root?.nodeId).toBe('a');
    expect(overview.tree.root?.children[0].incomingChoiceText).toBe('回头看她');
    expect(overview.endings).toEqual([
      { label: 'c', endingLabel: 'GE', script: '司机在加油站做出的选择。' },
    ]);
  });

  it('marks segments without readable copy as missing', () => {
    const nodes = [
      groupNode({ storyCharacters: [] }),
      segment('a', { start: true, narration: '开场' }),
      segment('b'),
      choice('a', 'b', '继续', 0),
    ];
    const edges = [choice('a', 'b', '继续', 0)];
    const overview = buildStoryOverview('g1', nodes as CanvasNode[], edges)!;
    expect(overview.scriptReadyCount).toBe(1);
    expect(overview.segmentsById.get('b')?.script).toBe('');
  });

  it('keeps DAG merges out of the endings list (repeated rows are not re-counted)', () => {
    const nodes = [
      groupNode(),
      segment('a', { start: true }),
      segment('b'),
      segment('c', { ending: 'GE' }),
    ];
    const edges = [
      choice('a', 'b', '去b', 0),
      choice('a', 'c', '直接结局', 1),
      choice('b', 'c', '也到c', 0),
    ];
    const overview = buildStoryOverview('g1', nodes, edges)!;
    // c 第一次展开是结局叶子；第二次到达是 ↩ 汇合引用，不再计一次结局。
    expect(overview.endings.map((e) => e.label)).toEqual(['c']);
    const directToC = overview.tree.root?.children.find((r) => r.nodeId === 'c');
    expect(directToC?.repeated).toBe(true);
    expect(directToC?.referenceKind).toBe('merge');
  });

  it('returns null when the target is not a story group', () => {
    expect(buildStoryOverview('g1', [], [])).toBeNull();
    const plain = { id: 'g1', type: 'groupNode', position: { x: 0, y: 0 }, data: {} } as CanvasNode;
    expect(buildStoryOverview('g1', [plain], [])).toBeNull();
  });
});
