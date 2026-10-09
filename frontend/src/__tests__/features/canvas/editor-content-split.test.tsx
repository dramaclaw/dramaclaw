// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { LightEditorContent } from '@/features/canvas/ui/LightEditorContent';
import { MultiAngleEditorContent } from '@/features/canvas/ui/MultiAngleEditorContent';
import { AssetBoardMultiAngleDialog } from '@/features/canvas/ui/asset-board/AssetBoardMultiAngleDialog';
import { AssetBoardRelightDialog } from '@/features/canvas/ui/asset-board/AssetBoardRelightDialog';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  useFreezoneImageModels: () => ({
    models: [{ id: 'huimeng/gpt-image-2', apiModel: 'gpt-image-2', label: 'GPT Image 2' }],
  }),
}));

const multiAngleImage = vi.hoisted(() => vi.fn());
const relightImage = vi.hoisted(() => vi.fn());
vi.mock('@/features/canvas/application/imageMultiAngle', () => ({ multiAngleImage }));
vi.mock('@/features/canvas/application/imageRelight', () => ({ relightImage }));

// 面板里的 Radix Slider 依赖 ResizeObserver，jsdom 没有（同
// canvas-skill-manual-connect.test.tsx 的做法，逐测试文件 stub）。
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const NODE = {
  id: 'src-1',
  type: CANVAS_NODE_TYPES.upload,
  position: { x: 0, y: 0 },
  data: { imageUrl: '/static/src.png', aspectRatio: '1:1' },
} as CanvasNode;

/** 面板的提交圆钮只有箭头图标，用 aria-label 定位。 */
function submitButton() {
  return screen.getByRole('button', { name: 'multiAngleEditor.submit' });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.getState().setCanvasData([NODE], []);
});

describe('编辑器内容层（不含 React Flow，可被工作流外壳与故事板弹窗共用）', () => {
  it('MultiAngleEditorContent：脱离 ReactFlowProvider 也能独立渲染完整面板', () => {
    // 关键回归点——内容层若还依赖 NodeToolbar/useReactFlow，这里会直接抛
    // 「Seems like you have not used zustand provider as an ancestor」。
    render(
      <MultiAngleEditorContent node={NODE} imageSource="/static/src.png" onClose={vi.fn()} />,
    );
    expect(screen.getByText('multiAngleEditor.title')).toBeInTheDocument();
  });

  it('MultiAngleEditorContent：提交成功 → onSubmitted(新节点 id) 先于 onClose', () => {
    multiAngleImage.mockReturnValue({ nodeId: 'mv-1', completion: Promise.resolve() });
    const calls: string[] = [];
    render(
      <MultiAngleEditorContent
        node={NODE}
        imageSource="/static/src.png"
        onClose={() => calls.push('close')}
        onSubmitted={(id) => calls.push(`submitted:${id}`)}
      />,
    );

    fireEvent.click(submitButton());

    expect(multiAngleImage).toHaveBeenCalledWith('src-1', '/static/src.png', expect.any(Object));
    // 顺序与拆分前的 handleSubmit 一致：先 setSelectedNode 再 onClose。
    expect(calls).toEqual(['submitted:mv-1', 'close']);
  });

  it('MultiAngleEditorContent：提交失败（编排返回 null）→ 不回调、不关闭', () => {
    multiAngleImage.mockReturnValue(null);
    const onClose = vi.fn();
    const onSubmitted = vi.fn();
    render(
      <MultiAngleEditorContent
        node={NODE}
        imageSource="/static/src.png"
        onClose={onClose}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.click(submitButton());

    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('LightEditorContent：脱离 ReactFlowProvider 也能独立渲染完整面板', () => {
    render(<LightEditorContent node={NODE} imageSource="/static/src.png" onClose={vi.fn()} />);
    expect(screen.getByText('lightEditor.title')).toBeInTheDocument();
  });
});

describe('故事板编辑器弹窗外壳', () => {
  it('多角度弹窗：portal 到 body 的居中弹窗，内含完整多维度编辑器', () => {
    const { baseElement } = render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '多维度编辑器' });
    // portal：弹窗挂在 body 上，而不是组件自己的容器里。
    expect(dialog.parentElement).toBe(baseElement);
    expect(screen.getByText('multiAngleEditor.title')).toBeInTheDocument();
  });

  it('多角度弹窗：点面板内部不关闭；点遮罩关闭且只触发一次', () => {
    const onClose = vi.fn();
    render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: '多维度编辑器' });

    fireEvent.click(screen.getByText('multiAngleEditor.title'));
    expect(onClose).not.toHaveBeenCalled();

    // 面板自身也有「点面板外即 onClose」的捕获监听，会和外壳的遮罩 onClick
    // 同时命中；外壳按挂载去重，宿主只应收到一次关闭。
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('多角度弹窗：Esc 关闭（两个面板自身都没有 Esc 关闭，由外壳补）', () => {
    const onClose = vi.fn();
    render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('多角度弹窗：提交成功 → 请求视口预定位（而非选中）', () => {
    multiAngleImage.mockReturnValue({ nodeId: 'mv-9', completion: Promise.resolve() });
    render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(submitButton());

    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('mv-9');
  });

  it('重打光弹窗：portal 居中弹窗，内含完整打光编辑器', () => {
    render(
      <AssetBoardRelightDialog node={NODE} imageSource="/static/src.png" onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: '打光效果编辑器' })).toBeInTheDocument();
    expect(screen.getByText('lightEditor.title')).toBeInTheDocument();
  });
});
