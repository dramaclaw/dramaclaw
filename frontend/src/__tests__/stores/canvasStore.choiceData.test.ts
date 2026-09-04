import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

function seed() {
  const store = useCanvasStore.getState();
  store.setCanvasData(
    [
      { id: 'story', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
      { id: 'v1', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 0, y: 0 }, data: { videoUrl: 'a.mp4', aspectRatio: '16:9' } },
      { id: 'v2', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 400, y: 0 }, data: { videoUrl: 'b.mp4', aspectRatio: '16:9' } },
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

  it('互动呈现按选择点统一同步，但每条选项边保留自己的锚点', () => {
    const store = useCanvasStore.getState();
    const firstId = store.edges[0].id;
    const secondId = store.addStoryChoiceEdge('v1', 'v2', '换一种走法')!;
    store.updateStoryChoiceEdgeData(firstId, {
      interaction: { presentation: 'overlay', anchor: { x: 0.2, y: 0.7 } },
    });

    store.setStoryChoicePresentation(secondId, 'object-anchor');

    const choices = useCanvasStore.getState().edges.filter((edge) => edge.source === 'v1');
    expect(choices).toHaveLength(2);
    expect(choices.map((edge) => (edge.data as { interaction?: { presentation?: string } }).interaction?.presentation))
      .toEqual(['object-anchor', 'object-anchor']);
    expect((choices[0].data as { interaction?: { anchor?: { x: number; y: number } } }).interaction?.anchor)
      .toEqual({ x: 0.2, y: 0.7 });
    expect((choices[1].data as { interaction?: { anchor?: { x: number; y: number } } }).interaction?.anchor)
      .toEqual({ x: 0.5, y: 0.5 });
  });

  it('新建选项继承选择点的锚定呈现，并提供可编辑的默认锚点', () => {
    const store = useCanvasStore.getState();
    const firstId = store.edges[0].id;
    store.setStoryChoicePresentation(firstId, 'baked-video');

    const addedId = store.addStoryChoiceEdge('v1', 'v2', '继续观察')!;
    const added = useCanvasStore.getState().edges.find((edge) => edge.id === addedId)!;

    expect((added.data as { interaction?: unknown }).interaction).toEqual({
      presentation: 'baked-video',
      anchor: { x: 0.5, y: 0.5, width: 0.24, height: 0.14 },
    });
  });

  it('相同的锚定呈现会补齐缺失锚点，默认 overlay 不产生空操作历史', () => {
    const store = useCanvasStore.getState();
    const firstId = store.edges[0].id;
    store.updateStoryChoiceEdgeData(firstId, { interaction: { presentation: 'object-anchor' } });

    store.setStoryChoicePresentation(firstId, 'object-anchor');
    const repaired = useCanvasStore.getState().edges.find((edge) => edge.id === firstId)!;
    expect((repaired.data as { interaction?: { anchor?: unknown } }).interaction?.anchor).toEqual({ x: 0.5, y: 0.5 });

    const historySize = useCanvasStore.getState().history.past.length;
    store.setStoryChoicePresentation(firstId, 'overlay');
    store.setStoryChoicePresentation(firstId, 'overlay');
    expect(useCanvasStore.getState().history.past).toHaveLength(historySize + 1);
  });
});
