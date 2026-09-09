import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { storyReferenceVisibleEdges } from '@/features/canvas/story/storyReferenceVisibility';

const nodes = [
  { id: 'group', type: CANVAS_NODE_TYPES.group, data: { storyGroup: true } },
  { id: 'clip', type: CANVAS_NODE_TYPES.video, parentId: 'group', data: {} },
  { id: 'next', type: CANVAS_NODE_TYPES.video, parentId: 'group', data: {} },
  { id: 'asset', type: CANVAS_NODE_TYPES.imageGen, data: {} },
  { id: 'ordinary', type: CANVAS_NODE_TYPES.video, data: {} },
].map((node) => ({ ...node, position: { x: 0, y: 0 } })) as CanvasNode[];
const edges = [
  { id: 'ref', source: 'asset', target: 'clip' },
  { id: 'ref2', source: 'asset', target: 'next' },
  { id: 'story', source: 'clip', target: 'next', type: 'storyChoiceEdge' },
  { id: 'normal', source: 'asset', target: 'ordinary' },
  { id: 'dependency', source: 'clip', target: 'next', data: { link_type: 'dependency_for' } },
] as CanvasEdge[];
const hidden = (result: CanvasEdge[]) => result.filter((edge) => edge.hidden).map((edge) => edge.id);
const select = (...ids: string[]) => nodes.map((node) => ({ ...node, selected: ids.includes(node.id) }));

describe('影游引用线按需显示', () => {
  it('默认隐藏素材线，保留剧情线、执行依赖和普通工作流，不修改原数据', () => {
    expect(hidden(storyReferenceVisibleEdges(nodes, edges))).toEqual(['ref', 'ref2']);
    expect(hidden(edges)).toEqual([]);
  });
  it('选中片段仅显示其引用，选中素材显示全部使用方，取消后恢复', () => {
    expect(hidden(storyReferenceVisibleEdges(select('clip'), edges))).toEqual(['ref2']);
    expect(storyReferenceVisibleEdges(select('asset'), edges)).toBe(edges);
    expect(storyReferenceVisibleEdges(select('clip', 'next'), edges)).toBe(edges);
    expect(hidden(storyReferenceVisibleEdges(select('group'), edges))).toEqual(['ref', 'ref2']);
    expect(hidden(storyReferenceVisibleEdges(select(), edges))).toEqual(['ref', 'ref2']);
  });
  it('全局隐藏优先，原本隐藏的边不被强行显示，移出故事组恢复普通行为', () => {
    expect(hidden(storyReferenceVisibleEdges(select('asset'), edges, true))).toHaveLength(edges.length);
    const originalHidden = [{ ...edges[0], hidden: true }];
    expect(storyReferenceVisibleEdges(select('asset'), originalHidden)).toBe(originalHidden);
    expect(storyReferenceVisibleEdges(nodes.filter((node) => node.id !== 'group'), edges)).toBe(edges);
  });
});
