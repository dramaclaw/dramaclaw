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

    fireEvent.pointerDown(anchorPicker, { pointerId: 1, clientX: 20, clientY: 20 });
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
