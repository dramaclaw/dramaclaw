import { describe, expect, it } from 'vitest';
import { isNodeStoryClip } from '@/features/canvas/story/storySelectors';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

function makeNodes(): CanvasNode[] {
  return [
    { id: 'sg', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { label: '故事', storyGroup: true, storyVariables: [] } },
    { id: 'pg', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { label: '普通组' } },
    { id: 'clip', type: CANVAS_NODE_TYPES.video, parentId: 'sg', position: { x: 0, y: 0 }, data: { videoUrl: null, aspectRatio: '16:9' } },
    { id: 'plainVideo', type: CANVAS_NODE_TYPES.video, parentId: 'pg', position: { x: 0, y: 0 }, data: { videoUrl: null, aspectRatio: '16:9' } },
    { id: 'freeVideo', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: null, aspectRatio: '16:9' } },
    { id: 'imgInStory', type: CANVAS_NODE_TYPES.imageGen, parentId: 'sg', position: { x: 0, y: 0 }, data: { imageUrl: null, aspectRatio: '16:9', prompt: '', model: '', size: '1K' } },
  ] as unknown as CanvasNode[];
}

describe('isNodeStoryClip', () => {
  const nodes = makeNodes();

  it('父组是 storyGroup 的视频节点 → true', () => {
    expect(isNodeStoryClip(nodes, 'clip')).toBe(true);
  });

  it('父组是普通组的视频节点 → false', () => {
    expect(isNodeStoryClip(nodes, 'plainVideo')).toBe(false);
  });

  it('无 parent 的自由视频节点 → false', () => {
    expect(isNodeStoryClip(nodes, 'freeVideo')).toBe(false);
  });

  it('故事组里的非视频节点(图片)→ false', () => {
    expect(isNodeStoryClip(nodes, 'imgInStory')).toBe(false);
  });

  it('空 / 未知 id → false', () => {
    expect(isNodeStoryClip(nodes, null)).toBe(false);
    expect(isNodeStoryClip(nodes, undefined)).toBe(false);
    expect(isNodeStoryClip(nodes, 'nope')).toBe(false);
  });
});
