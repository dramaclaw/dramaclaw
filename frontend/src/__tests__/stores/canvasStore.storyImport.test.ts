import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

describe('addStoryImport', () => {
  beforeEach(() => useCanvasStore.getState().setCanvasData([], []));

  it('把导入的节点/边追加进画布(保留已有内容)', () => {
    useCanvasStore.getState().setCanvasData(
      [{ id: 'existing', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: 'x.mp4', aspectRatio: '16:9' } }] as never,
      [],
    );
    const newNodes = [
      { id: 'g', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { label: '导入', storyGroup: true, storyVariables: [] } },
      { id: 'c', type: CANVAS_NODE_TYPES.video, parentId: 'g', position: { x: 10, y: 10 }, data: { videoUrl: null, aspectRatio: '16:9' } },
    ] as unknown as CanvasNode[];
    const newEdges: CanvasEdge[] = [];
    useCanvasStore.getState().addStoryImport(newNodes, newEdges);
    const ids = useCanvasStore.getState().nodes.map((n) => n.id);
    expect(ids).toContain('existing');
    expect(ids).toContain('g');
    expect(ids).toContain('c');
  });

  it('作为单个 undo 步(撤销后回到导入前)', () => {
    useCanvasStore.getState().setCanvasData(
      [{ id: 'existing', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: 'x.mp4', aspectRatio: '16:9' } }] as never,
      [],
    );
    const newNodes = [
      { id: 'g', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { label: '导入', storyGroup: true, storyVariables: [] } },
    ] as unknown as CanvasNode[];
    useCanvasStore.getState().addStoryImport(newNodes, []);
    useCanvasStore.getState().undo();
    const ids = useCanvasStore.getState().nodes.map((n) => n.id);
    expect(ids).toEqual(['existing']);
  });
});
