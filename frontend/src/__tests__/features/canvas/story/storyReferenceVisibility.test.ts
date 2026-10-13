import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { isReferenceDimmedEdge, storyReferenceVisibleEdges } from '@/features/canvas/story/storyReferenceVisibility';

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
const dimmed = (result: CanvasEdge[]) => result.filter(isReferenceDimmedEdge).map((edge) => edge.id);
const hidden = (result: CanvasEdge[]) => result.filter((edge) => edge.hidden).map((edge) => edge.id);
const select = (...ids: string[]) => nodes.map((node) => ({ ...node, selected: ids.includes(node.id) }));

describe('影游引用线减弱常显', () => {
  it('默认素材线常显但减弱，剧情线、执行依赖和普通工作流不受影响，不修改原数据', () => {
    const rendered = storyReferenceVisibleEdges(nodes, edges);
    expect(dimmed(rendered)).toEqual(['ref', 'ref2']);
    expect(hidden(rendered)).toEqual([]);
    expect(hidden(edges)).toEqual([]);
    expect(isReferenceDimmedEdge(edges[0]!)).toBe(false);
  });
  it('选中片段仅点亮其引用，选中素材不展开全部使用方，取消后恢复减弱', () => {
    expect(dimmed(storyReferenceVisibleEdges(select('clip'), edges))).toEqual(['ref2']);
    expect(dimmed(storyReferenceVisibleEdges(select('asset'), edges))).toEqual(['ref', 'ref2']);
    expect(storyReferenceVisibleEdges(select('clip', 'next'), edges)).toBe(edges);
    expect(dimmed(storyReferenceVisibleEdges(select('group'), edges))).toEqual(['ref', 'ref2']);
    expect(dimmed(storyReferenceVisibleEdges(select(), edges))).toEqual(['ref', 'ref2']);
  });
  it('全局隐藏优先，原本隐藏的边不被强行调整，移出故事组恢复普通行为', () => {
    expect(hidden(storyReferenceVisibleEdges(select('asset'), edges, true))).toHaveLength(edges.length);
    expect(dimmed(storyReferenceVisibleEdges(select('asset'), edges, true))).toHaveLength(0);
    const originalHidden = [{ ...edges[0], hidden: true }];
    expect(storyReferenceVisibleEdges(select('asset'), originalHidden)).toBe(originalHidden);
    expect(storyReferenceVisibleEdges(nodes.filter((node) => node.id !== 'group'), edges)).toBe(edges);
  });
});
