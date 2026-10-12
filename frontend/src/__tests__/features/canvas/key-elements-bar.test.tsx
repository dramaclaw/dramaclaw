// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

/** 收集本段内 publish 出来的 freezone/add-nodes-to-chat 载荷。 */
function captureAddToChat(run: () => void): string[][] {
  const seen: string[][] = [];
  const unsubscribe = canvasEventBus.subscribe('freezone/add-nodes-to-chat', ({ nodeIds }) => {
    seen.push(nodeIds);
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return seen;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

function imageNode(id: string, data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { imageUrl: `/static/${id}.png`, aspectRatio: '1:1', ...data },
  } as CanvasNode;
}

function audioNode(id: string, data: Record<string, unknown>): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.audio,
    position: { x: 0, y: 0 },
    data: { audioUrl: `/static/${id}.mp3`, displayName: '音频', ...data },
  } as CanvasNode;
}

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

/**
 * 顶部栏（有关键元素/音频才渲染）。结构：栏根 > 标签行(div) > 关键元素下拉触发器。
 * 触发器的最近 div 祖先是标签行，其父即栏根；栏内断言用 within(bar) 圈定，避免撞到
 * 图片栏里同名的卡片。
 */
function keyElementsBar(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /关键元素 ·/ });
  const bar = trigger.closest('div')?.parentElement;
  if (!(bar instanceof HTMLElement)) throw new Error('key elements bar not found');
  return bar;
}

describe('故事板关键元素栏', () => {
  it('没有任何关键元素 → 不渲染顶部栏', () => {
    seed([imageNode('a', { displayName: '角色A' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /关键元素 ·/ })).not.toBeInTheDocument();
  });

  it('有被标记的节点 → 顶部栏渲染其 chip（缩略图 + 名称）', () => {
    seed([
      imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' }),
      imageNode('b', { displayName: '普通图' }),
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    const bar = keyElementsBar();
    expect(within(bar).getByRole('button', { name: '主角立绘' })).toBeInTheDocument();
    // 未标记的不进栏。
    expect(within(bar).queryByRole('button', { name: '普通图' })).not.toBeInTheDocument();
  });

  it('分类筛选：切到「场景」只留场景类关键元素', async () => {
    const user = userEvent.setup();
    seed([
      imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' }),
      imageNode('b', { displayName: '森林场景', keyElementCategory: 'scene' }),
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // 默认「全部」：栏内两者都在（用 within 圈定栏，避开图片栏同名卡片）。
    expect(within(keyElementsBar()).getByRole('button', { name: '主角立绘' })).toBeInTheDocument();
    expect(within(keyElementsBar()).getByRole('button', { name: '森林场景' })).toBeInTheDocument();

    // 打开分类下拉切到「场景」。
    await user.click(screen.getByRole('button', { name: /关键元素 ·/ }));
    await user.click(await screen.findByRole('menuitem', { name: '场景' }));

    expect(within(keyElementsBar()).queryByRole('button', { name: '主角立绘' })).not.toBeInTheDocument();
    expect(within(keyElementsBar()).getByRole('button', { name: '森林场景' })).toBeInTheDocument();
  });

  it('点 chip → 打开该节点详情', () => {
    seed([imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(within(keyElementsBar()).getByRole('button', { name: '主角立绘' }));
    expect(screen.getByRole('region', { name: '资产详情' })).toBeInTheDocument();
  });

  it('关键元素配「添加到对话」pill 入口（对标 liblib 的 hover 浮层）', async () => {
    // 浮层走 Tooltip Portal，真实浏览器靠 CSS 仅在 hover 时可见；jsdom 无 CSS，
    // 这里只断言入口挂得出、可及名对得上，可见性交给上面的手动/视觉验证。
    const user = userEvent.setup();
    seed([imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    await user.hover(within(keyElementsBar()).getByRole('button', { name: '主角立绘' }));
    expect(await screen.findByRole('button', { name: '添加到对话' })).toBeInTheDocument();
  });

  it('点 pill → 走 add-nodes-to-chat 事件、带该节点 id，且不打开详情', async () => {
    const user = userEvent.setup();
    seed([imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    await user.hover(within(keyElementsBar()).getByRole('button', { name: '主角立绘' }));
    const pill = await screen.findByRole('button', { name: '添加到对话' });
    const events = captureAddToChat(() => {
      fireEvent.click(pill);
    });
    expect(events).toEqual([['a']]);
    // 点 pill 不误触缩略图的「打开详情」。
    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
  });

  it('关键元素 + 音频 → 顶栏两个标签，切到「音频」显示音频 chip（对标 liblib）', async () => {
    const user = userEvent.setup();
    seed([
      imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' }),
      audioNode('bg', { displayName: '背景音乐' }),
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // 两个标签并存。
    expect(screen.getByRole('button', { name: /关键元素 ·/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '音频' })).toBeInTheDocument();
    // 默认关键元素标签：栏内是关键元素 chip，音频 chip 未渲染。
    expect(within(keyElementsBar()).getByRole('button', { name: '主角立绘' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '背景音乐' })).not.toBeInTheDocument();

    // 切到音频标签 → 音频 chip 出现、关键元素 chip 收起。
    await user.click(screen.getByRole('button', { name: '音频' }));
    expect(within(keyElementsBar()).getByRole('button', { name: '背景音乐' })).toBeInTheDocument();
    expect(within(keyElementsBar()).queryByRole('button', { name: '主角立绘' })).not.toBeInTheDocument();
  });

  it('总览态挂在三栏之上；进详情后缩进左列（右半边整个让给详情面板）', () => {
    seed([imageNode('a', { displayName: '主角立绘', keyElementCategory: 'character' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // 总览态：关键元素栏与三栏容器是兄弟，不在任何一栏里面。
    const columns = screen.getByTestId('asset-board-columns');
    expect(columns.contains(keyElementsBar())).toBe(false);

    // 进详情：关键元素栏与左窄列表同在一个左列容器里，而详情面板在它外面。
    fireEvent.click(within(keyElementsBar()).getByRole('button', { name: '主角立绘' }));
    const detail = screen.getByRole('region', { name: '资产详情' });
    const leftColumn = keyElementsBar().parentElement as HTMLElement;
    expect(leftColumn.contains(detail)).toBe(false);
    // 左列里还挂着窄列表（栏切换下拉即它的标题槽）。
    expect(within(leftColumn).getByRole('button', { name: /切换栏目|图片|视频|文本/ })).toBeTruthy();
  });
});
