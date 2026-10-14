import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { storyDurationRange } from '@/features/canvas/story/storyDurationRange';

const clip = (id: string, durationMs: number, start = false): CanvasNode => ({
  id,
  type: CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  data: { durationMs, ...(start ? { storyRole: 'start' } : {}) },
} as CanvasNode);
const edge = (id: string, source: string, target: string): CanvasEdge => ({
  id, source, target, type: 'storyChoiceEdge',
} as CanvasEdge);

describe('单次游玩时长', () => {
  it('可重复选择本段时不报告有限时长或素材缺失', () => {
    expect(storyDurationRange(
      [clip('start', 10_000, true), clip('end', 10_000)],
      [edge('repeat', 'start', 'start'), edge('finish', 'start', 'end')],
    )).toBeNull();
  });

  it('跨片段循环同样不可计算', () => {
    expect(storyDurationRange(
      [clip('start', 10_000, true), clip('middle', 5_000), clip('end', 10_000)],
      [edge('a', 'start', 'middle'), edge('b', 'middle', 'start'), edge('c', 'middle', 'end')],
    )).toBeNull();
  });

  it('不可达循环不影响实际路线时长', () => {
    expect(storyDurationRange(
      [clip('start', 10_000, true), clip('end', 10_000), clip('unused', 5_000)],
      [edge('finish', 'start', 'end'), edge('repeat', 'unused', 'unused')],
    )).toEqual({ minMs: 20_000, maxMs: 20_000, complete: true });
  });

  it('无循环但缺少片段时长时保留不完整估算', () => {
    expect(storyDurationRange(
      [clip('start', 10_000, true), clip('end', 0)],
      [edge('finish', 'start', 'end')],
    )).toEqual({ minMs: 10_000, maxMs: 10_000, complete: false });
  });

  it('按实际路径取最短和最长，不累加互斥分支', () => {
    const result = storyDurationRange(
      [clip('start', 10_000, true), clip('short', 5_000), clip('long', 9_000), clip('end', 10_000)],
      [edge('a', 'start', 'short'), edge('b', 'start', 'long'), edge('c', 'short', 'end'), edge('d', 'long', 'end')],
    );
    expect(result).toEqual({ minMs: 25_000, maxMs: 29_000, complete: true });
  });
});
