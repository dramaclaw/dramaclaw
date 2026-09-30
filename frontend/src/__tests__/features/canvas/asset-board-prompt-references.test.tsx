// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePromptReferences } from '@/features/canvas/domain/promptReferences';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  useFreezoneImageModels: () => ({ models: [] }),
}));

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

/**
 * 两张上游图 → 一个结果节点，prompt 引用 @图1 / @图2。
 *
 * 结果节点用 imageEdit：imageGen 与 video 的详情现在都挂可编辑的生成表单
 * （@引用由 PromptMentionEditor 自己渲染成 chip），只读的 AssetBoardPromptText
 * 只服务于「详情不带生成表单」的节点类型，AI 图片编辑正是眼下这一类。
 * 它的标签家族是 `图N`（无「片」，见 resolvePromptReferences 的 labelPrefix）；
 * `图片N` / `视频N` / `音频N` 的编号规则由下面那组纯函数用例覆盖。
 */
function seedGraph(prompt: string, extra: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'ref-a',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/a.png', displayName: '参考A' },
    } as CanvasNode,
    {
      id: 'ref-b',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 100 },
      data: { imageUrl: '/static/b.png', displayName: '参考B' },
    } as CanvasNode,
    {
      id: 'gen-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 300, y: 0 },
      data: {
        imageUrl: '/static/out.png',
        displayName: '生成图',
        prompt,
        ...extra,
      },
    } as CanvasNode,
  ];
  const edges: CanvasEdge[] = [
    { id: 'e1', source: 'ref-a', target: 'gen-1' } as CanvasEdge,
    { id: 'e2', source: 'ref-b', target: 'gen-1' } as CanvasEdge,
  ];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

describe('详情提示词的 @引用 chip', () => {
  beforeEach(() => {
    seedGraph('把 @图1 的人物放进 @图2 的场景');
  });

  it('命中的引用渲染成带缩略图的 chip（普通文本原样保留）', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '生成图' }));

    const detail = detailPanel();
    // @图1 / @图2 各渲染一个 chip，缩略图按连线顺序对应上游 A / B。
    const chip1 = within(detail).getByRole('button', { name: '图1' });
    const chip2 = within(detail).getByRole('button', { name: '图2' });
    expect(within(chip1).getByRole('img')).toHaveAttribute('src', '/static/a.png');
    expect(within(chip2).getByRole('img')).toHaveAttribute('src', '/static/b.png');
    // 非引用文本原样。
    expect(within(detail).getByText(/把/)).toBeInTheDocument();
    expect(within(detail).getByText(/的人物放进/)).toBeInTheDocument();
  });

  it('hover chip 弹出大图预览（portal 到 body）', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '生成图' }));

    const chip = within(detailPanel()).getByRole('button', { name: '图1' });
    expect(screen.getAllByRole('img', { name: '图1' })).toHaveLength(1);
    fireEvent.mouseEnter(chip.parentElement as HTMLElement);
    // 预览图是第二个同源 img（chip 缩略图 + portal 大图）。
    const previews = screen.getAllByRole('img').filter((img) => img.getAttribute('src') === '/static/a.png');
    expect(previews.length).toBeGreaterThan(1);
    fireEvent.mouseLeave(chip.parentElement as HTMLElement);
  });

  it('没有对应参考的引用保持纯文本（不渲染空 chip、不报错）', () => {
    // 只有 2 个上游 → @图9 解析不到目标。
    seedGraph('用 @图9 试试');
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '生成图' }));

    const detail = detailPanel();
    expect(within(detail).queryByRole('button', { name: '图9' })).not.toBeInTheDocument();
    expect(within(detail).getByText(/用 @图9 试试/)).toBeInTheDocument();
  });

  it('只读：chip 不带 detach / 删除角标', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '生成图' }));

    const chip = within(detailPanel()).getByRole('button', { name: '图1' });
    expect(within(chip.parentElement as HTMLElement).queryByRole('button', { name: /取消引用|移除|detach/i }))
      .not.toBeInTheDocument();
  });
});

describe('resolvePromptReferences（编号规则复用工作流那份）', () => {
  it('图片家族：节点自带参考图占「图片1」，上游图顺延（与 orderedReferenceUrlsWithOwnFirst 一致）', () => {
    const upstream: CanvasNode[] = [
      {
        id: 'ref-a',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/a.png' },
      } as CanvasNode,
    ];
    const node = {
      id: 'gen-1',
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 0, y: 0 },
      data: { referenceImageUrl: '/static/own.png', prompt: '' },
    } as CanvasNode;

    const targets = resolvePromptReferences(node, upstream);
    // 自带参考图排第 1 —— 若这里错位，@图片N 就会整体偏移 1。
    expect(targets.get('图片1')?.thumbnailUrl).toBe('/static/own.png');
    expect(targets.get('图片1')?.nodeId).toBeNull();
    expect(targets.get('图片2')?.thumbnailUrl).toBe('/static/a.png');
    expect(targets.get('图片2')?.nodeId).toBe('ref-a');
  });

  it('AI 图片编辑节点用 `图N` 标签（无「片」），编号基线是纯上游图片、无自带参考图位', () => {
    const upstream: CanvasNode[] = [
      {
        id: 'ref-a',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/a.png' },
      } as CanvasNode,
      {
        id: 'ref-b',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/b.png' },
      } as CanvasNode,
    ];
    const node = {
      id: 'edit-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      // referenceImageUrl 对 imageEdit 不参与编号（只有 imageGen 才占「图片1」）。
      data: { referenceImageUrl: '/static/own.png', prompt: '' },
    } as CanvasNode;

    const targets = resolvePromptReferences(node, upstream);
    expect(targets.get('图1')?.thumbnailUrl).toBe('/static/a.png');
    expect(targets.get('图2')?.thumbnailUrl).toBe('/static/b.png');
    // 不应产出 imageGen 家族的「图片N」标签，也不应把自带参考图排进来。
    expect(targets.has('图片1')).toBe(false);
    expect([...targets.values()].some((t) => t.thumbnailUrl === '/static/own.png')).toBe(false);
  });

  it('视频家族：图/视/音各自独立计数，且尊重 referenceOrder 手动重排', () => {
    const upstream: CanvasNode[] = [
      {
        id: 'img-1',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/i1.png' },
      } as CanvasNode,
      {
        id: 'vid-1',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: { videoUrl: '/static/v1.mp4', previewImageUrl: '/static/v1.png' },
      } as CanvasNode,
      {
        id: 'img-2',
        type: CANVAS_NODE_TYPES.upload,
        position: { x: 0, y: 0 },
        data: { imageUrl: '/static/i2.png' },
      } as CanvasNode,
    ];
    const node = {
      id: 'video-node',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      // 手动把 img-2 拖到最前 → 它成为 图片1。
      data: { prompt: '', referenceOrder: ['img-2', 'img-1', 'vid-1'] },
    } as CanvasNode;

    const targets = resolvePromptReferences(node, upstream);
    expect(targets.get('图片1')?.nodeId).toBe('img-2');
    expect(targets.get('图片2')?.nodeId).toBe('img-1');
    // 视频不占用图片的序号（各自独立计数）。
    expect(targets.get('视频1')?.nodeId).toBe('vid-1');
    expect(targets.get('视频1')?.thumbnailUrl).toBe('/static/v1.png');
  });
});
