import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';

function seedTwoVideos() {
  const store = useCanvasStore.getState();
  store.setCanvasData(
    [
      { id: 'story', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
      { id: 'v1', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 0, y: 0 }, data: { videoUrl: 'a.mp4', aspectRatio: '16:9' } },
      { id: 'v2', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 400, y: 0 }, data: { videoUrl: 'b.mp4', aspectRatio: '16:9' } },
    ] as never,
    [],
  );
}

describe('canvasStore story actions', () => {
  beforeEach(seedTwoVideos);

  it('addStoryChoiceEdge 建出 storyChoiceEdge 类型的边并带文案', () => {
    const id = useCanvasStore.getState().addStoryChoiceEdge('v1', 'v2', '去 v2');
    expect(id).toBeTruthy();
    const edge = useCanvasStore.getState().edges.find((e) => e.id === id);
    expect(edge?.type).toBe(STORY_CHOICE_EDGE_TYPE);
    expect((edge?.data as { choiceText?: string }).choiceText).toBe('去 v2');
  });

  it('同一源的多条选项边 order 递增', () => {
    useCanvasStore.getState().setCanvasData(
      [
        { id: 'story', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
        { id: 'v1', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 0, y: 0 }, data: { videoUrl: 'a.mp4', aspectRatio: '16:9' } },
        { id: 'v2', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 400, y: 0 }, data: { videoUrl: 'b.mp4', aspectRatio: '16:9' } },
        { id: 'v3', type: CANVAS_NODE_TYPES.video, parentId: 'story', position: { x: 400, y: 300 }, data: { videoUrl: 'c.mp4', aspectRatio: '16:9' } },
      ] as never,
      [],
    );
    useCanvasStore.getState().addStoryChoiceEdge('v1', 'v2', '选项一');
    useCanvasStore.getState().addStoryChoiceEdge('v1', 'v3', '选项二');
    const fromV1 = useCanvasStore.getState().edges.filter((e) => e.source === 'v1');
    const orders = fromV1.map((e) => (e.data as { order: number }).order).sort();
    expect(orders).toEqual([0, 1]);
  });

  it('addStoryChoiceEdge source===target 时返回 null', () => {
    const id = useCanvasStore.getState().addStoryChoiceEdge('v1', 'v1', '自环');
    expect(id).toBeNull();
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it('addStoryChoiceEdge target 不存在时返回 null', () => {
    const id = useCanvasStore.getState().addStoryChoiceEdge('v1', 'no-such-node', '幽灵边');
    expect(id).toBeNull();
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it('addStoryChoiceEdge 拒绝不在同一故事组里的普通视频', () => {
    useCanvasStore.getState().setCanvasData(
      [
        { id: 'v1', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: 'a.mp4' } },
        { id: 'v2', type: CANVAS_NODE_TYPES.video, position: { x: 400, y: 0 }, data: { videoUrl: 'b.mp4' } },
      ] as never,
      [],
    );

    expect(useCanvasStore.getState().addStoryChoiceEdge('v1', 'v2', '不应创建')).toBeNull();
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it('setStoryStartNode 设起点且同组唯一', () => {
    const store = useCanvasStore.getState();
    store.setStoryStartNode('v1');
    store.setStoryStartNode('v2');
    const nodes = useCanvasStore.getState().nodes;
    expect((nodes.find((n) => n.id === 'v1')?.data as { storyRole?: string }).storyRole).toBeUndefined();
    expect((nodes.find((n) => n.id === 'v2')?.data as { storyRole?: string }).storyRole).toBe('start');
  });

  it('更改起点不清除其他故事组的起点，无效目标不修改数据', () => {
    const store = useCanvasStore.getState();
    useCanvasStore.setState({ nodes: store.nodes.map((node) => ({
      ...node, parentId: node.id === 'v1' ? 'g1' : 'g2',
    })) });
    store.setStoryStartNode('v1');
    store.setStoryStartNode('v2');
    expect(useCanvasStore.getState().nodes.filter((node) => node.data.storyRole === 'start')).toHaveLength(2);
    const previous = useCanvasStore.getState().nodes;
    store.setStoryStartNode('missing');
    expect(useCanvasStore.getState().nodes).toBe(previous);
  });
});
