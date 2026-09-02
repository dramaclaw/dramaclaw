import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  STORY_CLIP_NODE_HEIGHT,
  STORY_CLIP_NODE_WIDTH,
} from '@/features/canvas/story/storyClipLayout';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { selectStoryVariablesForEdgeSource } from '@/features/canvas/story/storyVariableSelectors';

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
    expect((group.data as { interactiveStoryId?: string }).interactiveStoryId).toBe(`story-${gid}`);
    expect((group.data as { interactiveStorySchemaVersion?: string }).interactiveStorySchemaVersion).toBe('story_draft.v1');
    expect((group.data as { storyVariables?: unknown[] }).storyVariables).toEqual([]);
    expect((group.data as { storyVariableDefinitions?: unknown[] }).storyVariableDefinitions).toEqual([]);
    expect(nodes.find((n) => n.id === 'v1')!.parentId).toBe(gid);
    expect((nodes.find((n) => n.id === 'v1')!.data as { storySegmentId?: string }).storySegmentId).toBe('segment-v1');
    expect(nodes.find((n) => n.id === 'v1')).toMatchObject({
      width: STORY_CLIP_NODE_WIDTH,
      height: STORY_CLIP_NODE_HEIGHT,
      style: { width: STORY_CLIP_NODE_WIDTH, height: STORY_CLIP_NODE_HEIGHT },
    });
  });

  it('addStorySegment 向既有故事组追加空白片段并保留单步撤销快照', () => {
    const gid = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    const historyBefore = useCanvasStore.getState().history.past.length;

    const segmentId = useCanvasStore.getState().addStorySegment(gid);

    expect(segmentId).toBeTruthy();
    const state = useCanvasStore.getState();
    const segment = state.nodes.find((node) => node.id === segmentId)!;
    expect(segment.type).toBe(CANVAS_NODE_TYPES.video);
    expect(segment.parentId).toBe(gid);
    expect(segment.selected).toBe(true);
    expect(state.selectedNodeId).toBe(segmentId);
    expect(state.pendingFocusNodeId).toBe(segmentId);
    expect(state.history.past).toHaveLength(historyBefore + 1);
    expect(segment.data).toMatchObject({
      displayName: '片段 1',
      videoUrl: null,
      narration: '',
      storyProductionNotes: '',
      storyMedia: { source: 'placeholder', status: 'missing', version: 1 },
      storySegmentId: `segment-${segmentId}`,
    });
    expect(segment).toMatchObject({
      width: STORY_CLIP_NODE_WIDTH,
      height: STORY_CLIP_NODE_HEIGHT,
    });

    expect(useCanvasStore.getState().undo()).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === segmentId)).toBe(false);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === gid)).toBe(true);
  });

  it('addStorySegment 拒绝普通组，不产生画布修改', () => {
    const groupId = useCanvasStore.getState().groupNodes(['v1', 'v2'], { label: '普通组' })!;
    const nodeCount = useCanvasStore.getState().nodes.length;

    expect(useCanvasStore.getState().addStorySegment(groupId)).toBeNull();
    expect(useCanvasStore.getState().nodes).toHaveLength(nodeCount);
  });

  it('addStorySegment 保留画布定位入组的坐标和初始数据', () => {
    const groupId = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    const segmentId = useCanvasStore.getState().addStorySegment(groupId, {
      position: { x: 180, y: 96 },
      data: { narration: '手动添加的剧情' },
    })!;

    expect(useCanvasStore.getState().nodes.find((node) => node.id === segmentId)).toMatchObject({
      parentId: groupId,
      position: { x: 180, y: 96 },
      data: { narration: '手动添加的剧情' },
    });
  });

  it('统一连线入口把同一故事组的视频连线转换为可编辑的剧情选项边', () => {
    const groupId = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    useCanvasStore.getState().addStoryVariable(groupId, '好感度');

    useCanvasStore.getState().onConnect({
      source: 'v1',
      target: 'v2',
      sourceHandle: 'source',
      targetHandle: 'target',
    });

    const state = useCanvasStore.getState();
    const edge = state.edges.find((candidate) => candidate.source === 'v1' && candidate.target === 'v2');
    expect(edge).toMatchObject({
      type: STORY_CHOICE_EDGE_TYPE,
      selected: true,
      data: { choiceText: '', order: 0 },
    });
    expect(selectStoryVariablesForEdgeSource(state.nodes, 'v1')).toEqual([
      expect.objectContaining({ label: '好感度', initial: 0 }),
    ]);
  });

  it('重复拖出尚未配置的同目标剧情边时只选中已有边', () => {
    useCanvasStore.getState().createStoryGroup(['v1', 'v2']);
    const connection = {
      source: 'v1',
      target: 'v2',
      sourceHandle: 'source',
      targetHandle: 'target',
    };

    useCanvasStore.getState().onConnect(connection);
    const firstId = useCanvasStore.getState().edges[0].id;
    useCanvasStore.getState().onConnect(connection);

    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().edges[0]).toMatchObject({
      id: firstId,
      selected: true,
      data: { choiceText: '', order: 0 },
    });
  });

  it('删除较早选项后新增剧情边仍使用未占用的递增 order 和 id', () => {
    const groupId = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    const thirdId = useCanvasStore.getState().addStorySegment(groupId)!;
    const fourthId = useCanvasStore.getState().addStorySegment(groupId)!;
    const firstId = useCanvasStore.getState().addStoryChoiceEdge('v1', 'v2', '选项一')!;
    useCanvasStore.getState().addStoryChoiceEdge('v1', thirdId, '选项二');

    useCanvasStore.getState().deleteEdge(firstId);
    const latestId = useCanvasStore.getState().addStoryChoiceEdge('v1', fourthId, '选项三')!;
    const outgoing = useCanvasStore.getState().edges.filter((edge) => edge.source === 'v1');

    expect(new Set(outgoing.map((edge) => edge.id)).size).toBe(outgoing.length);
    expect(outgoing.find((edge) => edge.id === latestId)?.data).toMatchObject({ order: 2 });
    expect(outgoing.map((edge) => (edge.data as { order: number }).order).sort()).toEqual([1, 2]);
  });

  it('有明确文案时允许多个选项通向同一剧情片段', () => {
    useCanvasStore.getState().createStoryGroup(['v1', 'v2']);

    useCanvasStore.getState().addStoryChoiceEdge('v1', 'v2', '坦白');
    useCanvasStore.getState().addStoryChoiceEdge('v1', 'v2', '隐瞒');

    const outgoing = useCanvasStore.getState().edges.filter((edge) => edge.source === 'v1');
    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((edge) => (edge.data as { order: number }).order)).toEqual([0, 1]);
    expect(new Set(outgoing.map((edge) => edge.id)).size).toBe(2);
  });

  it('剧情视频替换后同步 storyMedia 状态、来源和版本', () => {
    const groupId = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    const segmentId = useCanvasStore.getState().addStorySegment(groupId)!;

    useCanvasStore.getState().updateNodeData(segmentId, {
      isUploading: true,
      sourceFileName: 'first.mp4',
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === segmentId)?.data.storyMedia)
      .toMatchObject({ source: 'imported', status: 'pending', version: 1 });

    useCanvasStore.getState().updateNodeData(segmentId, {
      videoUrl: '/first.mp4',
      isUploading: false,
      sourceFileName: 'first.mp4',
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === segmentId)?.data.storyMedia)
      .toMatchObject({ source: 'imported', status: 'ready', url: '/first.mp4', version: 1 });

    useCanvasStore.getState().updateNodeData(segmentId, {
      videoUrl: null,
      isGenerating: true,
      sourceFileName: null,
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === segmentId)?.data.storyMedia)
      .toMatchObject({ source: 'generated', status: 'pending', url: '/first.mp4', version: 1 });

    useCanvasStore.getState().updateNodeData(segmentId, {
      videoUrl: '/second.mp4',
      isGenerating: false,
      sourceFileName: null,
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === segmentId)?.data.storyMedia)
      .toMatchObject({ source: 'generated', status: 'ready', url: '/second.mp4', version: 2 });
  });

  it('打开旧故事时统一横竖视频片段的复合卡尺寸', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'story',
          type: CANVAS_NODE_TYPES.group,
          position: { x: 0, y: 0 },
          data: { label: '互动影游', storyGroup: true },
        },
        {
          id: 'landscape',
          type: CANVAS_NODE_TYPES.video,
          parentId: 'story',
          position: { x: 20, y: 40 },
          width: 620,
          height: 349,
          style: { width: 620, height: 349 },
          data: { videoUrl: 'landscape.mp4', widthPx: 1344, heightPx: 768 },
        },
        {
          id: 'portrait',
          type: CANVAS_NODE_TYPES.video,
          parentId: 'story',
          position: { x: 700, y: 40 },
          width: 580,
          height: 1000,
          style: { width: 580, height: 1000 },
          data: { videoUrl: 'portrait.mp4', widthPx: 2160, heightPx: 3840 },
        },
      ] as never,
      [],
    );

    for (const id of ['landscape', 'portrait']) {
      expect(useCanvasStore.getState().nodes.find((node) => node.id === id)).toMatchObject({
        width: STORY_CLIP_NODE_WIDTH,
        height: STORY_CLIP_NODE_HEIGHT,
        style: { width: STORY_CLIP_NODE_WIDTH, height: STORY_CLIP_NODE_HEIGHT },
      });
    }
  });

  it('打开旧 AI 故事时扩开旧尺寸列距，并同步撑大故事组', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'story',
          type: CANVAS_NODE_TYPES.group,
          position: { x: 0, y: 0 },
          width: 1300,
          height: 420,
          data: { label: '旧 AI 故事', storyGroup: true },
        },
        {
          id: 'first',
          type: CANVAS_NODE_TYPES.video,
          parentId: 'story',
          position: { x: 60, y: 60 },
          width: 460,
          height: 300,
          data: { videoUrl: 'first.mp4' },
        },
        {
          id: 'second',
          type: CANVAS_NODE_TYPES.video,
          parentId: 'story',
          position: { x: 680, y: 60 },
          width: 460,
          height: 300,
          data: { videoUrl: 'second.mp4' },
        },
      ] as never,
      [],
    );

    const nodes = useCanvasStore.getState().nodes;
    const first = nodes.find((node) => node.id === 'first')!;
    const second = nodes.find((node) => node.id === 'second')!;
    const group = nodes.find((node) => node.id === 'story')!;
    expect(first.position).toEqual({ x: 60, y: 60 });
    expect(second.position.x - first.position.x).toBeGreaterThanOrEqual(STORY_CLIP_NODE_WIDTH);
    expect(group.width).toBeGreaterThanOrEqual(second.position.x + STORY_CLIP_NODE_WIDTH + 60);
  });

  it('竖屏视频 metadata 写回时不会把故事片段拉成竖卡', () => {
    const groupId = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;

    useCanvasStore.getState().updateNodeData('v1', {
      widthPx: 2160,
      heightPx: 3840,
    });

    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'v1')).toMatchObject({
      parentId: groupId,
      width: STORY_CLIP_NODE_WIDTH,
      height: STORY_CLIP_NODE_HEIGHT,
    });
  });

  it('保留用户手动调整过的故事片段尺寸', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'story',
          type: CANVAS_NODE_TYPES.group,
          position: { x: 0, y: 0 },
          data: { label: '互动影游', storyGroup: true },
        },
        {
          id: 'custom',
          type: CANVAS_NODE_TYPES.video,
          parentId: 'story',
          position: { x: 20, y: 40 },
          width: 820,
          height: 458,
          style: { width: 820, height: 458 },
          data: {
            videoUrl: 'portrait.mp4',
            widthPx: 2160,
            heightPx: 3840,
            isSizeManuallyAdjusted: true,
          },
        },
      ] as never,
      [],
    );

    expect(useCanvasStore.getState().nodes.find((node) => node.id === 'custom')).toMatchObject({
      width: 820,
      height: 458,
    });
  });

  it('addStoryVariable / updateStoryVariable / removeStoryVariable 改对应组 data', () => {
    const gid = useCanvasStore.getState().createStoryGroup(['v1', 'v2'])!;
    const name = useCanvasStore.getState().addStoryVariable(gid, '好感');
    expect(/^[a-zA-Z_]/.test(name)).toBe(true);
    useCanvasStore.getState().updateStoryVariable(gid, name, { initial: 5 });
    let groupData = useCanvasStore.getState().nodes.find((n) => n.id === gid)!.data as {
      storyVariables: { name: string; initial: number }[];
      storyVariableDefinitions: { name: string; initial: number }[];
    };
    let vars = groupData.storyVariables;
    expect(vars[0].initial).toBe(5);
    expect(groupData.storyVariableDefinitions).toEqual(groupData.storyVariables);
    useCanvasStore.getState().removeStoryVariable(gid, name);
    groupData = useCanvasStore.getState().nodes.find((n) => n.id === gid)!.data as typeof groupData;
    vars = groupData.storyVariables;
    expect(vars).toHaveLength(0);
    expect(groupData.storyVariableDefinitions).toEqual([]);
  });

  it('openStoryVariables / closeStoryVariables 切换目标组', () => {
    useCanvasStore.getState().openStoryVariables('g-x');
    expect(useCanvasStore.getState().openStoryVariablesGroupId).toBe('g-x');
    useCanvasStore.getState().closeStoryVariables();
    expect(useCanvasStore.getState().openStoryVariablesGroupId).toBeNull();
  });
});
