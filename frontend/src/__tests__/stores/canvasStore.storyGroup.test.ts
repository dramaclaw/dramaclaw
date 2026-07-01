import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

function seedTwoVideos() {
  useCanvasStore.getState().setCanvasData(
    [
      { id: 'v1', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: { videoUrl: 'a.mp4', aspectRatio: '16:9' } },
      { id: 'v2', type: CANVAS_NODE_TYPES.video, position: { x: 400, y: 0 }, data: { videoUrl: 'b.mp4', aspectRatio: '16:9' } },
    ] as never,
    [],
  );
}

describe('canvasStore story group', () => {
  beforeEach(seedTwoVideos);

  it('createStoryGroup 建带 storyGroup 标记的组,成员 parentId 指向它', () => {
    const gid = useCanvasStore.getState().createStoryGroup(['v1', 'v2']);
    expect(gid).toBeTruthy();
    const nodes = useCanvasStore.getState().nodes;
    const group = nodes.find((n) => n.id === gid)!;
    expect((group.data as { storyGroup?: boolean }).storyGroup).toBe(true);
    expect((group.data as { storyVariables?: unknown[] }).storyVariables).toEqual([]);
    expect(nodes.find((n) => n.id === 'v1')!.parentId).toBe(gid);
  });

  it('addStoryVariable / updateStoryVariable / removeStoryVariable 改对应组 data', () => {
    const gid = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    const name = useCanvasStore.getState().addStoryVariable(gid, '好感');
    expect(/^[a-zA-Z_]/.test(name)).toBe(true);
    useCanvasStore.getState().updateStoryVariable(gid, name, { initial: 5 });
    let vars = (useCanvasStore.getState().nodes.find((n) => n.id === gid)!.data as { storyVariables: { name: string; initial: number }[] }).storyVariables;
    expect(vars[0].initial).toBe(5);
    useCanvasStore.getState().removeStoryVariable(gid, name);
    vars = (useCanvasStore.getState().nodes.find((n) => n.id === gid)!.data as { storyVariables: { name: string; initial: number }[] }).storyVariables;
    expect(vars).toHaveLength(0);
  });

  it('openStoryVariables / closeStoryVariables 切换目标组', () => {
    useCanvasStore.getState().openStoryVariables('g-x');
    expect(useCanvasStore.getState().openStoryVariablesGroupId).toBe('g-x');
    useCanvasStore.getState().closeStoryVariables();
    expect(useCanvasStore.getState().openStoryVariablesGroupId).toBeNull();
  });
});
