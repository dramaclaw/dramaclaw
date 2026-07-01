import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

function seed() {
  const store = useCanvasStore.getState();
  store.setCanvasData(
    [
      { id: 'v1', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: 'a.mp4', aspectRatio: '16:9' } },
      { id: 'v2', type: CANVAS_NODE_TYPES.video, position: { x: 400, y: 0 }, data: { videoUrl: 'b.mp4', aspectRatio: '16:9' } },
    ] as never,
    [],
  );
  return store.addStoryChoiceEdge('v1', 'v2', '去 v2')!;
}

describe('updateStoryChoiceEdgeData', () => {
  beforeEach(seed);

  it('更新选中边的 condition/effects/choiceText', () => {
    const id = useCanvasStore.getState().edges[0].id;
    useCanvasStore.getState().updateStoryChoiceEdgeData(id, {
      choiceText: '表白',
      condition: { var: 'fav', op: '>=', value: 3 },
      effects: [{ var: 'fav', delta: 1 }],
    });
    const edge = useCanvasStore.getState().edges.find((e) => e.id === id)!;
    expect((edge.data as { choiceText: string }).choiceText).toBe('表白');
    expect((edge.data as { condition?: { value: number } }).condition?.value).toBe(3);
    expect((edge.data as { effects?: unknown[] }).effects).toHaveLength(1);
  });
});
