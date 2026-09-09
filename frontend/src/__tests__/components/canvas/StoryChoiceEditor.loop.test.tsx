// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StoryChoiceEditor } from '@/components/canvas/StoryChoiceEditor';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const originalUpdateStoryChoiceEdgeData = useCanvasStore.getState().updateStoryChoiceEdgeData;

// 一个故事组 + 两个组内视频成员。members selector 只有在组内有成员时才会 map 出对象,
// 因此复现死循环必须让 sourceNode 挂在有成员的组下。
function seedStoryGroup() {
  useCanvasStore.getState().setCanvasData(
    [
      { id: 'g1', type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
      {
        id: 'v1',
        type: CANVAS_NODE_TYPES.video,
        parentId: 'g1',
        position: { x: 0, y: 0 },
        data: { videoUrl: 'a.mp4', aspectRatio: '16:9', displayName: '片段一' },
      },
      {
        id: 'v2',
        type: CANVAS_NODE_TYPES.video,
        parentId: 'g1',
        position: { x: 400, y: 0 },
        data: { videoUrl: 'b.mp4', aspectRatio: '16:9', displayName: '片段二' },
      },
    ] as never,
    [],
  );
}

describe('StoryChoiceEditor 渲染不触发无限重渲染', () => {
  beforeEach(() => {
    // Zustand 的 set 会把 spy 函数复制进下一份 state；每个用例显式恢复原 action，
    // 避免前一用例的调用记录污染后续断言。
    useCanvasStore.setState({ updateStoryChoiceEdgeData: originalUpdateStoryChoiceEdgeData });
    seedStoryGroup();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['object-anchor', 'baked-video'] as const)('竖屏 %s 预览完整画面并按媒体比例定位', (presentation) => {
    render(<StoryChoiceEditor edgeId="e1" sourceNodeId="v1" choiceText="选择"
      interaction={{ presentation, anchor: { x: 0.5, y: 0.25, width: 0.2, height: 0.1 } }} variables={[]} />);
    const frame = screen.getByTestId('story-hotspot-preview');
    const video = frame.querySelector('video')!;
    Object.defineProperty(frame, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 225, height: 400 }) });
    Object.defineProperties(video, { videoWidth: { value: 1080 }, videoHeight: { value: 1920 }, duration: { value: 5 } });
    fireEvent.loadedMetadata(video);
    expect(video.className).toContain('object-contain');
    expect(parseFloat(frame.style.aspectRatio)).toBe(9 / 16);
    expect(frame.className).not.toContain('aspect-video');
    const anchor = screen.getByLabelText(presentation === 'baked-video' ? 'canvas.story.interactionMoveHotspot' : 'canvas.story.interactionPickAnchor');
    expect(anchor.style.left).toBe('112.5px');
    expect(anchor.style.top).toBe('100px');
    if (presentation === 'baked-video') {
      expect(anchor.style.width).toBe('45px');
      expect(anchor.style.height).toBe('40px');
    }
  });

  it('组内有成员时挂载编辑器不应抛 "Maximum update depth exceeded"', () => {
    // 修复前:members selector 在 useShallow 内 .map 出新对象,快照永不相等 → useSyncExternalStore
    // 判定快照一直在变 → React 抛 "Maximum update depth exceeded"。render 会同步抛出使本用例失败。
    expect(() =>
      render(
        <StoryChoiceEditor
          edgeId="e1"
          sourceNodeId="v1"
          choiceText="去片段二"
          variables={[]}
        />,
      ),
    ).not.toThrow();
  });

  it('以居中模态呈现，避免被画布边中点裁切', () => {
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="去片段二"
        variables={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('拼音组字完成前不写回选项边，避免重渲染打断候选词', () => {
    const update = vi.spyOn(useCanvasStore.getState(), 'updateStoryChoiceEdgeData');
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText=""
        variables={[]}
      />,
    );

    const input = screen.getByPlaceholderText('canvas.story.choicePrompt');
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'xuanxiang' } });

    expect(update).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { value: '选项' } });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('e1', { choiceText: '选项' });
  });

  it('拼音组字时按 Escape 只取消候选窗，不关闭编辑器', () => {
    const onClose = vi.fn();
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText=""
        variables={[]}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('不展示尚未在底部选项生效的分支过渡配置', () => {
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="拿起手电筒"
        interaction={{ presentation: 'object-anchor', anchor: { x: 0.5, y: 0.5 } }}
        variables={[]}
      />,
    );

    expect(screen.queryByLabelText('canvas.story.interactionTransition')).not.toBeInTheDocument();
  });

  it('不展示不影响热区的锚定物品备注', () => {
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="拿起手电筒"
        interaction={{
          presentation: 'object-anchor',
          anchor: { x: 0.5, y: 0.5, objectLabel: '手电筒' },
        }}
        variables={[]}
      />,
    );

    expect(screen.queryByPlaceholderText('canvas.story.interactionObjectPlaceholder'))
      .not.toBeInTheDocument();
  });

  it('拖动锚点期间只更新本地预览，松手时才写一次画布', () => {
    const update = vi.spyOn(useCanvasStore.getState(), 'updateStoryChoiceEdgeData');
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="拿起手电筒"
        interaction={{ presentation: 'object-anchor', anchor: { x: 0.5, y: 0.5 } }}
        variables={[]}
      />,
    );

    const anchorPicker = screen.getByLabelText('canvas.story.interactionPickAnchor');
    Object.defineProperties(anchorPicker, {
      getBoundingClientRect: {
        value: () => ({ left: 0, top: 0, width: 200, height: 100 }),
      },
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() },
    });

    fireEvent.pointerDown(anchorPicker, { pointerId: 2, button: 0, clientX: 110, clientY: 55 });
    fireEvent.pointerUp(anchorPicker, { pointerId: 2, clientX: 110, clientY: 55 });
    expect(update).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId('story-hotspot-preview'), { pointerId: 3, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(screen.getByTestId('story-hotspot-preview'), { pointerId: 3, clientX: 10, clientY: 10 });
    expect(update).not.toHaveBeenCalled();

    fireEvent.pointerDown(anchorPicker, { pointerId: 1, button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(anchorPicker, { pointerId: 1, clientX: 80, clientY: 50 });
    fireEvent.pointerMove(anchorPicker, { pointerId: 1, clientX: 160, clientY: 70 });

    expect(update).not.toHaveBeenCalled();

    fireEvent.pointerUp(anchorPicker, { pointerId: 1, clientX: 160, clientY: 70 });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('e1', {
      interaction: expect.objectContaining({ anchor: { x: 0.8, y: 0.7 } }),
    });
  });

  it('视频内 UI 使用截图式矩形与四角拖拽手柄', () => {
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="打开舱门"
        interaction={{
          presentation: 'baked-video',
          anchor: { x: 0.5, y: 0.5, width: 0.32, height: 0.18 },
        }}
        variables={[]}
      />,
    );

    expect(screen.getByRole('group', { name: 'canvas.story.interactionMoveHotspot' }))
      .toHaveTextContent('32% × 18%');
    expect(screen.getAllByLabelText('canvas.story.interactionResizeHotspot')).toHaveLength(4);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('可直接在尾帧上拖动框选热区，松手时只写回一次', () => {
    const update = vi.spyOn(useCanvasStore.getState(), 'updateStoryChoiceEdgeData');
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="打开舱门"
        interaction={{
          presentation: 'baked-video',
          anchor: { x: 0.5, y: 0.5, width: 0.32, height: 0.18 },
        }}
        variables={[]}
      />,
    );

    const drawSurface = screen.getByLabelText('canvas.story.interactionDrawHotspot');
    Object.defineProperties(drawSurface, {
      getBoundingClientRect: {
        value: () => ({ left: 0, top: 0, width: 200, height: 100 }),
      },
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() },
    });

    fireEvent.pointerDown(drawSurface, { pointerId: 7, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(drawSurface, { pointerId: 7, clientX: 100, clientY: 70 });
    expect(update).not.toHaveBeenCalled();
    fireEvent.pointerUp(drawSurface, { pointerId: 7, clientX: 100, clientY: 70 });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe('e1');
    const anchor = (update.mock.calls[0]?.[1] as {
      interaction?: { anchor?: { x: number; y: number; width: number; height: number } };
    }).interaction?.anchor;
    expect(anchor?.x).toBeCloseTo(0.3);
    expect(anchor?.y).toBeCloseTo(0.45);
    expect(anchor?.width).toBeCloseTo(0.4);
    expect(anchor?.height).toBeCloseTo(0.5);
  });

  it('可拖动矩形左上角同时调整宽高', () => {
    const update = vi.spyOn(useCanvasStore.getState(), 'updateStoryChoiceEdgeData');
    render(
      <StoryChoiceEditor
        edgeId="e1"
        sourceNodeId="v1"
        choiceText="打开舱门"
        interaction={{
          presentation: 'baked-video',
          anchor: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
        }}
        variables={[]}
      />,
    );

    const frame = screen.getByTestId('story-hotspot-preview');
    Object.defineProperty(frame, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    });
    const northWestHandle = screen.getAllByLabelText('canvas.story.interactionResizeHotspot')[0]!;
    Object.defineProperties(northWestHandle, {
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: () => true },
      releasePointerCapture: { value: vi.fn() },
    });

    fireEvent.pointerDown(northWestHandle, { pointerId: 9, clientX: 60, clientY: 30 });
    fireEvent.pointerMove(northWestHandle, { pointerId: 9, clientX: 40, clientY: 20 });
    expect(update).not.toHaveBeenCalled();
    fireEvent.pointerUp(northWestHandle, { pointerId: 9, clientX: 40, clientY: 20 });

    const anchor = (update.mock.calls[0]?.[1] as {
      interaction?: { anchor?: { x: number; y: number; width: number; height: number } };
    }).interaction?.anchor;
    expect(update).toHaveBeenCalledTimes(1);
    expect(anchor?.x).toBeCloseTo(0.45);
    expect(anchor?.y).toBeCloseTo(0.45);
    expect(anchor?.width).toBeCloseTo(0.5);
    expect(anchor?.height).toBeCloseTo(0.5);
  });
});

describe('锚定选项共同预览与对齐', () => {
  it('显示其他锚点、点击切换，并一次对齐及撤销，保留热区和其他片段', () => {
    seedStoryGroup();
    const makeEdge = (id: string, x: number, y: number, presentation = 'object-anchor', source = 'v1') => ({
      id, source, target: 'v2', type: 'storyChoiceEdge', data: {
        choiceText: id, interaction: { presentation, anchor: { x, y, width: 0.2, height: 0.1 }, uiStyle: 'glass', motion: 'fade' },
      },
    });
    const edges = [makeEdge('a', 0.2, 0.7), makeEdge('b', 0.5, 0.6), makeEdge('c', 0.8, 0.8), makeEdge('hotspot', 0.4, 0.2, 'baked-video'), makeEdge('other', 0.6, 0.3, 'object-anchor', 'v2')];
    useCanvasStore.setState({ edges: edges as never });
    render(<StoryChoiceEditor edgeId="a" sourceNodeId="v1" choiceText="a" interaction={edges[0].data.interaction as never} variables={[]} />);
    const preview = screen.getByTestId('story-hotspot-preview');
    expect(preview.textContent).toContain('b');
    expect(preview.textContent).toContain('c');
    expect(preview.textContent).not.toContain('hotspot');
    const video = preview.querySelector('video');
    fireEvent.click(Array.from(preview.querySelectorAll('button')).find((button) => button.textContent === 'b')!);
    expect(screen.getByTestId('story-hotspot-preview').querySelector('video')).toBe(video);
    expect(screen.getByLabelText('canvas.story.interactionPickAnchor')).toHaveTextContent('b');
    fireEvent.click(Array.from(preview.querySelectorAll('button')).find((button) => button.textContent === 'a')!);
    expect(screen.getByTestId('story-hotspot-preview').querySelector('video')).toBe(video);
    const before = useCanvasStore.getState().history.past.length;
    fireEvent.click(screen.getByText('canvas.story.alignAnchors'));
    const values = useCanvasStore.getState().edges.map((edge) => (edge.data as typeof edges[0]['data']).interaction.anchor);
    expect(values.map(({ x, y }) => [x, y])).toEqual([[0.2, 0.7], [0.5, 0.7], [0.8, 0.7], [0.4, 0.2], [0.6, 0.3]]);
    expect(useCanvasStore.getState().history.past).toHaveLength(before + 1);
    useCanvasStore.getState().undo();
    expect((useCanvasStore.getState().edges[1].data as typeof edges[0]['data']).interaction.anchor.y).toBe(0.6);
    const readInteractions = () => useCanvasStore.getState().edges.map((edge) => (edge.data as typeof edges[0]['data']).interaction);
    const anchors = readInteractions().map((value) => value.anchor);
    const historyLength = useCanvasStore.getState().history.past.length;
    fireEvent.change(screen.getByLabelText('canvas.story.interactionStyle'), { target: { value: 'warning' } });
    expect(readInteractions().map((value) => value.uiStyle)).toEqual(['warning', 'warning', 'warning', 'glass', 'glass']);
    expect(useCanvasStore.getState().history.past).toHaveLength(historyLength + 1);
    fireEvent.change(screen.getByLabelText('canvas.story.interactionMotion'), { target: { value: 'pulse' } });
    expect(readInteractions().map((value) => value.motion)).toEqual(['pulse', 'pulse', 'pulse', 'fade', 'fade']);
    expect(readInteractions().map((value) => value.anchor)).toEqual(anchors);
    useCanvasStore.getState().undo();
    expect(readInteractions().slice(0, 3).map((value) => value.motion)).toEqual(['fade', 'fade', 'fade']);
    expect(readInteractions().slice(0, 3).map((value) => value.uiStyle)).toEqual(['warning', 'warning', 'warning']);

  });
});

describe('拖动水平辅助线', () => {
  it('接近同片段锚点时吸附，远离释放，松手保存一次并隐藏辅助线', () => {
    seedStoryGroup();
    const interaction = { presentation: 'object-anchor', anchor: { x: 0.2, y: 0.5 }, uiStyle: 'glass' };
    useCanvasStore.setState({ edges: [
      { id: 'drag', source: 'v1', target: 'v2', type: 'storyChoiceEdge', data: { choiceText: '拖动', interaction } },
      { id: 'peer', source: 'v1', target: 'v2', type: 'storyChoiceEdge', data: { choiceText: '参考', interaction: { ...interaction, anchor: { x: 0.8, y: 0.7 } } } },
      { id: 'hotspot', source: 'v1', target: 'v2', type: 'storyChoiceEdge', data: { interaction: { presentation: 'baked-video', anchor: { x: 0.5, y: 0.62 } } } },
    ] as never });
    render(<StoryChoiceEditor edgeId="drag" sourceNodeId="v1" choiceText="拖动" interaction={interaction as never} variables={[]} />);
    const frame = screen.getByTestId('story-hotspot-preview');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 500 } as DOMRect);
    fireEvent(window, new Event('resize'));
    const button = screen.getByLabelText('canvas.story.interactionPickAnchor');
    Object.defineProperties(button, {
      setPointerCapture: { value: vi.fn() }, hasPointerCapture: { value: () => true }, releasePointerCapture: { value: vi.fn() },
    });
    const past = useCanvasStore.getState().history.past.length;
    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 200, clientY: 250 });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 250, clientY: 346 });
    expect(screen.getByTestId('story-horizontal-guide')).toHaveStyle({ top: '350px' });
    expect(button).toHaveStyle({ left: '250px', top: '350px' });
    expect(useCanvasStore.getState().history.past).toHaveLength(past);
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 250, clientY: 310 });
    expect(screen.queryByTestId('story-horizontal-guide')).not.toBeInTheDocument();
    expect(button).toHaveStyle({ top: '310px' });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: 250, clientY: 354 });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 250, clientY: 354 });
    expect(screen.queryByTestId('story-horizontal-guide')).not.toBeInTheDocument();
    expect((useCanvasStore.getState().edges[0].data as { interaction: typeof interaction }).interaction.anchor).toEqual({ x: 0.25, y: 0.7 });
    expect(useCanvasStore.getState().history.past).toHaveLength(past + 1);
  });
});
