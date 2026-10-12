// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { REFERENCE_DROP_HINT_TEXT } from '@/features/canvas/ui/asset-board/AssetBoardReferenceDropZone';
import { BOARD_REFERENCE_DRAG_MIME } from '@/features/canvas/ui/asset-board/boardReferenceDrag';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

// 算力询价走 react-query，测试树里没有 QueryClientProvider —— 直接短路。
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    { id: 'huimeng/test-image', providerId: 'huimeng', apiModel: 'test_image_api', label: '测试模型' },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
}));

/** dataTransfer 桩：Map backing store + `types` 反映已 setData 的 key（dragover 只能读 types）。 */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    // 自定义拖拽虚影入口——卡片在 dragStart 时会调它把虚影换成只显示内容缩略图。
    setDragImage: vi.fn(),
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: '',
    dropEffect: '',
  };
}

function seed(nodes: CanvasNode[], edges: CanvasEdge[] = []) {
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

/** 当前详情的目标图片生成节点（空节点即可，媒体区占位、下方挂完整表单）。 */
function targetImageNode(): CanvasNode {
  return {
    id: 'gen-1',
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: {
      imageUrl: null,
      prompt: '',
      aspectRatio: '16:9',
      size: '2K',
      displayName: '目标图片节点',
    },
  };
}

/** 左列表里可拖拽的参考图片卡片（upload 节点，带缩略图 → 落成上游即显示为图片 chip）。 */
function referenceImageNode(): CanvasNode {
  return {
    id: 'ref-2',
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 200, y: 0 },
    data: {
      imageUrl: '/static/ref.png',
      previewImageUrl: '/static/ref.png',
      aspectRatio: '1:1',
      displayName: '参考图片卡片',
    },
  };
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

/**
 * 左列表里某标题对应卡片的可拖拽根元素。当前详情节点的标题在详情工具条里也会以
 * 按钮出现，故用 getAll + 「在可拖拽卡片内」的按钮筛出真正的左列表卡片。
 */
function leftListCard(title: string): HTMLElement {
  for (const button of screen.getAllByRole('button', { name: title })) {
    const card = button.closest('div[draggable="true"]');
    if (card instanceof HTMLElement) return card;
  }
  throw new Error(`draggable card not found for ${title}`);
}

/** drop 区内的一个稳定落点（生成按钮在表单里、表单在放置层里，drop 会冒泡到放置层）。 */
function dropTarget() {
  return within(detailPanel()).getByRole('button', { name: '生成' });
}

describe('故事板详情 · 拖拽加引用', () => {
  it('左列表卡片是拖拽源（draggable），拖起时写入引用 payload', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '目标图片节点' }));

    const card = leftListCard('参考图片卡片');
    expect(card).toHaveAttribute('draggable', 'true');

    const dt = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    expect(dt.getData(BOARD_REFERENCE_DRAG_MIME)).toBe(JSON.stringify({ nodeId: 'ref-2' }));
  });

  it('拖拽虚影只用内容缩略图，不带标题/参考素材面板（setDragImage 指向缩略图容器）', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '目标图片节点' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('参考图片卡片'), { dataTransfer: dt });

    expect(dt.setDragImage).toHaveBeenCalledTimes(1);
    const dragImageEl = dt.setDragImage.mock.calls[0][0] as HTMLElement;
    // 传的是缩略图容器：含参考缩略图 <img>，但本身不是 draggable 的整卡根，
    // 也不包含标题按钮 → 虚影里不会带上标题与参考素材面板。
    expect(dragImageEl.querySelector('img')?.getAttribute('src')).toBe('/static/ref.png');
    expect(dragImageEl).not.toHaveAttribute('draggable');
    expect(within(dragImageEl).queryByRole('button', { name: '参考图片卡片' })).not.toBeInTheDocument();
  });

  it('拖动经过表单参考区 → 高亮提示文案出现', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '目标图片节点' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('参考图片卡片'), { dataTransfer: dt });
    // 悬停前没有提示层。
    expect(within(detailPanel()).queryByText(REFERENCE_DROP_HINT_TEXT)).not.toBeInTheDocument();

    fireEvent.dragEnter(dropTarget(), { dataTransfer: dt });
    expect(within(detailPanel()).getByText(REFERENCE_DROP_HINT_TEXT)).toBeInTheDocument();

    // 离开后收起（进出计数归零）。
    fireEvent.dragLeave(dropTarget(), { dataTransfer: dt });
    expect(within(detailPanel()).queryByText(REFERENCE_DROP_HINT_TEXT)).not.toBeInTheDocument();
  });

  it('拖入表单参考区落下 → store 建上游边、引用作为缩略图 chip 出现在表单', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '目标图片节点' }));

    // 落下前：无边、表单里没有引用 chip。
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    expect(within(detailPanel()).queryByTitle('取消引用此素材')).not.toBeInTheDocument();

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('参考图片卡片'), { dataTransfer: dt });
    fireEvent.dragEnter(dropTarget(), { dataTransfer: dt });
    fireEvent.drop(dropTarget(), { dataTransfer: dt });

    // 建了一条 ref-2 → gen-1 的上游边（复用工作流 addEdge，确定性 id）。
    const edges = useCanvasStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'ref-2', target: 'gen-1' });

    // 回流后：表单参考区出现该引用的缩略图 chip（自带取消引用按钮）+ 提示层收起。
    expect(within(detailPanel()).getByTitle('取消引用此素材')).toBeInTheDocument();
    expect(within(detailPanel()).queryByText(REFERENCE_DROP_HINT_TEXT)).not.toBeInTheDocument();
  });

  it('去重：拖入已是上游的节点不重复建边', () => {
    seed(
      [targetImageNode(), referenceImageNode()],
      [
        {
          id: 'e-ref-2-gen-1',
          source: 'ref-2',
          target: 'gen-1',
          sourceHandle: 'source',
          targetHandle: 'target',
          type: 'disconnectableEdge',
        },
      ],
    );
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '目标图片节点' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('参考图片卡片'), { dataTransfer: dt });
    fireEvent.drop(dropTarget(), { dataTransfer: dt });

    // 仍只有原来那一条边（addEdge 按 e-source-target 幂等去重）。
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it('把当前详情节点自己的卡片拖进自己的表单 → 忽略，不建自环边', () => {
    seed([targetImageNode(), referenceImageNode()]);
    render(<AssetBoardView visible onLocateNode={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '目标图片节点' }));

    const dt = makeDataTransfer();
    fireEvent.dragStart(leftListCard('目标图片节点'), { dataTransfer: dt });
    fireEvent.drop(dropTarget(), { dataTransfer: dt });

    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });
});
