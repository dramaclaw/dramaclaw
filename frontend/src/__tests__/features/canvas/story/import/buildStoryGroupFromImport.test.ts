import { describe, expect, it } from 'vitest';
import type { ImportedStory } from '@/features/canvas/story/import/importTypes';
import { buildStoryGroupFromImport } from '@/features/canvas/story/import/buildStoryGroupFromImport';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';

function counterIdGen() {
  let n = 0;
  return () => `n${n++}`;
}

const STORY: ImportedStory = {
  variables: [{ name: 'favor', initial: 0 }],
  startKnot: 'start',
  warnings: [],
  knots: [
    {
      name: 'start', narration: '深夜寝殿', videoHint: 'intro.mp4', tags: [], isEnding: false, warnings: [],
      outgoing: [
        { kind: 'choice', text: '接受召见', target: 'palace', effects: [{ var: 'favor', delta: 5 }], needsReview: false },
        { kind: 'choice', text: '称病推辞', target: 'sick', effects: [], needsReview: false },
      ],
    },
    { name: 'palace', narration: '金殿', videoHint: 'palace.mp4', tags: [], isEnding: false, warnings: [],
      outgoing: [{ kind: 'divert', target: 'judge', effects: [], needsReview: false }] },
    { name: 'sick', narration: '宫墙', videoHint: 'sick.mp4', tags: [], isEnding: false, warnings: [],
      outgoing: [{ kind: 'divert', target: 'judge', effects: [], needsReview: false }] },
    { name: 'judge', narration: '天平', videoHint: 'judge.mp4', tags: [], isEnding: false, warnings: [],
      outgoing: [
        { kind: 'autoConditional', target: 'ge', effects: [], condition: 'favor >= 5 && trust >= 0', needsReview: true, reviewNote: '复合条件' },
      ] },
    { name: 'ge', narration: '宠冠后宫', tags: ['ending: GE'], isEnding: true, warnings: [], outgoing: [] },
  ],
};

describe('buildStoryGroupFromImport', () => {
  it('生成故事组 + 每个 knot 一个占位视频片段 + 变量进组', () => {
    const { nodes } = buildStoryGroupFromImport(STORY, { idGen: counterIdGen() });
    const group = nodes.find((n) => n.type === CANVAS_NODE_TYPES.group)!;
    expect((group.data as { storyGroup?: boolean }).storyGroup).toBe(true);
    expect((group.data as { storyVariables?: unknown[] }).storyVariables).toEqual([{ name: 'favor', label: 'favor', initial: 0 }]);
    const clips = nodes.filter((n) => n.type === CANVAS_NODE_TYPES.video);
    expect(clips).toHaveLength(5);
    clips.forEach((c) => expect(c.parentId).toBe(group.id));
    const start = clips.find((c) => (c.data as { narration?: string }).narration === '深夜寝殿')!;
    expect((start.data as { storyRole?: string }).storyRole).toBe('start');
    expect((start.data as { videoHint?: string }).videoHint).toBe('intro.mp4');
    expect((start.data as { videoUrl: unknown }).videoUrl).toBeNull();
  });

  it('每条 outgoing 生成 storyChoiceEdge;choice 带文案/效果', () => {
    const { edges } = buildStoryGroupFromImport(STORY, { idGen: counterIdGen() });
    const storyEdges = edges.filter((e) => e.type === STORY_CHOICE_EDGE_TYPE);
    expect(storyEdges.length).toBe(5); // start:2 + palace:1 + sick:1 + judge:1 + ge:0 = 5
    const choiceEdge = storyEdges.find((e) => (e.data as { choiceText?: string }).choiceText === '接受召见')!;
    expect((choiceEdge.data as { effects?: { delta: number }[] }).effects).toEqual([{ var: 'favor', delta: 5 }]);
  });

  it('autoConditional 复合条件结构化为 AND 组并清除 needsReview', () => {
    const { edges } = buildStoryGroupFromImport(STORY, { idGen: counterIdGen() });
    const judgeEdge = edges.find(
      (e) => (e.data as { condition?: { join?: string } }).condition?.join != null,
    )!;
    expect((judgeEdge.data as { condition?: unknown }).condition).toEqual({
      join: 'and',
      items: [
        { var: 'favor', op: '>=', value: 5 },
        { var: 'trust', op: '>=', value: 0 },
      ],
    });
    expect((judgeEdge.data as { needsReview?: boolean }).needsReview).toBeFalsy();
  });

  it('复合 OR 条件结构化为 or 组', () => {
    const story: ImportedStory = {
      variables: [{ name: 'favor', initial: 0 }], startKnot: 'a', warnings: [],
      knots: [
        { name: 'a', narration: 'A', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'choice', text: '去 b', target: 'b', effects: [], condition: 'favor >= 5 || favor < 1', needsReview: false } ] },
        { name: 'b', narration: 'B', tags: [], isEnding: true, warnings: [], outgoing: [] },
      ],
    };
    const { edges } = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const e = edges.find((x) => (x.data as { choiceText?: string }).choiceText === '去 b')!;
    expect((e.data as { condition?: unknown }).condition).toEqual({
      join: 'or',
      items: [
        { var: 'favor', op: '>=', value: 5 },
        { var: 'favor', op: '<', value: 1 },
      ],
    });
    expect((e.data as { needsReview?: boolean }).needsReview).toBeFalsy();
  });

  it('混合 && 和 || 无法结构化 → 保持 needsReview、不挂 condition', () => {
    const story: ImportedStory = {
      variables: [{ name: 'favor', initial: 0 }], startKnot: 'a', warnings: [],
      knots: [
        { name: 'a', narration: 'A', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'autoConditional', target: 'b', effects: [], condition: 'favor >= 5 && favor < 9 || favor == 0', needsReview: true, reviewNote: '复合条件' } ] },
        { name: 'b', narration: 'B', tags: [], isEnding: true, warnings: [], outgoing: [] },
      ],
    };
    const { edges } = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const e = edges.find((x) => x.type === STORY_CHOICE_EDGE_TYPE)!;
    expect((e.data as { condition?: unknown }).condition).toBeUndefined();
    expect((e.data as { needsReview?: boolean }).needsReview).toBe(true);
  });

  it('自动/条件跳转的空文案边给默认标签(继续 / 条件 / 否则),真实选项保留原文案', () => {
    const story: ImportedStory = {
      variables: [], startKnot: 'a', warnings: [],
      knots: [
        { name: 'a', narration: 'A', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'autoConditional', target: 'b', effects: [], condition: 'trust >= 3', needsReview: true },
          { kind: 'autoConditional', target: 'c', effects: [], needsReview: true },
        ] },
        { name: 'b', narration: 'B', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'divert', target: 'd', effects: [], needsReview: false },
        ] },
        { name: 'c', narration: 'C', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'choice', text: '真实选项', target: 'd', effects: [], needsReview: false },
        ] },
        { name: 'd', narration: 'D', tags: [], isEnding: true, warnings: [], outgoing: [] },
      ],
    };
    const { nodes, edges } = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const nameById = new Map(
      nodes.filter((n) => n.type === CANVAS_NODE_TYPES.video)
        .map((n) => [n.id, (n.data as { displayName?: string }).displayName]),
    );
    const labelOf = (from: string, to: string) => {
      const e = edges.find((x) => nameById.get(x.source) === from && nameById.get(x.target) === to)!;
      return (e.data as { choiceText?: string }).choiceText;
    };
    expect(labelOf('a', 'b')).toBe('trust >= 3'); // 条件跳转 → 条件文本
    expect(labelOf('a', 'c')).toBe('否则');        // 无条件 autoConditional → 否则
    expect(labelOf('b', 'd')).toBe('继续');        // 纯自动跳转 → 继续
    expect(labelOf('c', 'd')).toBe('真实选项');    // 真实选项保留
  });

  it('故事组带背景色;传入 center 时居中放置,否则在原点(向后兼容)', () => {
    const story: ImportedStory = {
      variables: [], startKnot: 'a', warnings: [],
      knots: [{ name: 'a', narration: 'A', tags: [], isEnding: true, warnings: [], outgoing: [] }],
    };
    const centered = buildStoryGroupFromImport(story, { idGen: counterIdGen(), center: { x: 1000, y: 500 } });
    const g1 = centered.nodes.find((n) => n.type === CANVAS_NODE_TYPES.group)!;
    expect((g1.data as { backgroundColor?: string }).backgroundColor).toBeTruthy();
    const w = g1.width as number;
    const h = g1.height as number;
    expect(g1.position.x + w / 2).toBeCloseTo(1000);
    expect(g1.position.y + h / 2).toBeCloseTo(500);

    const plain = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const g2 = plain.nodes.find((n) => n.type === CANVAS_NODE_TYPES.group)!;
    expect(g2.position).toEqual({ x: 0, y: 0 });
  });

  it('布局按连线关系:子在父右侧,父纵向居中于子之间(重心对齐,非逐行堆叠)', () => {
    const story: ImportedStory = {
      variables: [], startKnot: 'a', warnings: [],
      knots: [
        { name: 'a', narration: 'A', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'choice', text: '去b', target: 'b', effects: [], needsReview: false },
          { kind: 'choice', text: '去c', target: 'c', effects: [], needsReview: false },
        ] },
        { name: 'b', narration: 'B', tags: [], isEnding: true, warnings: [], outgoing: [] },
        { name: 'c', narration: 'C', tags: [], isEnding: true, warnings: [], outgoing: [] },
      ],
    };
    const { nodes } = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const find = (n: string) => nodes.find((x) => (x.data as { narration?: string }).narration === n)!;
    const a = find('A'), b = find('B'), c = find('C');
    expect(b.position.x).toBeGreaterThan(a.position.x);
    expect(c.position.x).toBeGreaterThan(a.position.x);
    const lo = Math.min(b.position.y, c.position.y);
    const hi = Math.max(b.position.y, c.position.y);
    expect(a.position.y).toBeGreaterThan(lo);
    expect(a.position.y).toBeLessThan(hi);
  });

  it('单一简单条件被结构化为 condition 对象', () => {
    const story: ImportedStory = {
      variables: [{ name: 'favor', initial: 0 }], startKnot: 'a', warnings: [],
      knots: [
        { name: 'a', narration: 'A', tags: [], isEnding: false, warnings: [], outgoing: [
          { kind: 'choice', text: '去 b', target: 'b', effects: [], condition: 'favor >= 3', needsReview: false } ] },
        { name: 'b', narration: 'B', tags: [], isEnding: true, warnings: [], outgoing: [] },
      ],
    };
    const { edges } = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const e = edges.find((x) => (x.data as { choiceText?: string }).choiceText === '去 b')!;
    expect((e.data as { condition?: unknown }).condition).toEqual({ var: 'favor', op: '>=', value: 3 });
    expect((e.data as { needsReview?: boolean }).needsReview).toBeFalsy();
  });

  it('限时:knot.choiceTimeLimitSec → 节点数据;link.isDefault → 边数据', () => {
    const story: ImportedStory = {
      variables: [], startKnot: 'a', warnings: [],
      knots: [
        { name: 'a', narration: 'A', tags: [], isEnding: false, warnings: [], choiceTimeLimitSec: 4, outgoing: [
          { kind: 'choice', text: '默认项', target: 'b', effects: [], needsReview: false, isDefault: true },
          { kind: 'choice', text: '另一项', target: 'b', effects: [], needsReview: false },
        ] },
        { name: 'b', narration: 'B', tags: [], isEnding: true, endingLabel: 'BE', warnings: [], outgoing: [] },
      ],
    };
    const { nodes, edges } = buildStoryGroupFromImport(story, { idGen: counterIdGen() });
    const clipA = nodes.find((n) => (n.data as { narration?: string }).narration === 'A')!;
    expect((clipA.data as { choiceTimeLimitSec?: number }).choiceTimeLimitSec).toBe(4);
    const clipB = nodes.find((n) => (n.data as { narration?: string }).narration === 'B')!;
    expect((clipB.data as { endingLabel?: string }).endingLabel).toBe('BE');
    const def = edges.find((x) => (x.data as { choiceText?: string }).choiceText === '默认项')!;
    expect((def.data as { isDefault?: boolean }).isDefault).toBe(true);
    const other = edges.find((x) => (x.data as { choiceText?: string }).choiceText === '另一项')!;
    expect((other.data as { isDefault?: boolean }).isDefault).toBeFalsy();
  });
});
