import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';

describe('storyEditNodeId(故事片段编辑态)', () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
    useCanvasStore.getState().setStoryEditNode(null);
    useCanvasStore.getState().setSelectedNode(null);
  });

  it('setStoryEditNode 写入编辑态节点 id', () => {
    useCanvasStore.getState().setStoryEditNode('clip-1');
    expect(useCanvasStore.getState().storyEditNodeId).toBe('clip-1');
  });

  it('切到别的选中节点时自动清空编辑态(自动收回)', () => {
    useCanvasStore.getState().setSelectedNode('clip-1');
    useCanvasStore.getState().setStoryEditNode('clip-1');
    useCanvasStore.getState().setSelectedNode('clip-2');
    expect(useCanvasStore.getState().storyEditNodeId).toBeNull();
  });

  it('取消选中(null)也清空编辑态', () => {
    useCanvasStore.getState().setStoryEditNode('clip-1');
    useCanvasStore.getState().setSelectedNode(null);
    expect(useCanvasStore.getState().storyEditNodeId).toBeNull();
  });

  it('重新选中同一节点不清空编辑态', () => {
    useCanvasStore.getState().setSelectedNode('clip-1');
    useCanvasStore.getState().setStoryEditNode('clip-1');
    useCanvasStore.getState().setSelectedNode('clip-1');
    expect(useCanvasStore.getState().storyEditNodeId).toBe('clip-1');
  });
});
