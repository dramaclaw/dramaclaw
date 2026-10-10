// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// ImageViewerModal（AssetBoardView 内常驻挂载）用到 useTranslation。
vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock('react-i18next', () => ({
  // 第二参数可能是插值对象（如 t(key, { count })，视频生成表单的「生成数量」用到），
  // 只有字符串才当默认文案；否则会把对象当 React 子节点渲染而炸掉整棵树。
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

// 宫格活价（M2）用了 react-query 的 useGenerationCreditCost，测试树没有
// QueryClientProvider —— 直接 mock 掉，让组件退回硬编码 cost 兜底展示。
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

function seedBoard() {
  const nodes: CanvasNode[] = [
    {
      id: 'text-1',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { content: '# 项目信息\n\n品牌：光影', displayName: '锚点清单' },
    },
    {
      id: 'img-1',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 100 },
      data: {
        imageUrl: '/static/img1.png',
        prompt: '九宫格铅笔线稿分镜草图',
        model: 'test-model',
        size: '1K',
        aspectRatio: '1:1',
        displayName: '分镜草图',
      },
    },
    {
      id: 'img-2',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 200, y: 100 },
      data: {
        imageUrl: '/static/img2.png',
        prompt: '',
        model: 'test-model',
        size: '1K',
        aspectRatio: '1:1',
        displayName: '第二张图',
      },
    },
    {
      id: 'ref-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 400, y: 100 },
      data: { imageUrl: '/static/ref.png', aspectRatio: '1:1', displayName: '角色参考' },
    },
    {
      // videoCompose（成片/合成）是无生成表单的只读视频节点：其详情底部仍渲染
      // 「参考素材」只读行（下面几条跨栏「编辑/定位」用例依赖它）。普通 video
      // 生成节点有表单、底部行被 !showGenerationForm 收掉，另起用例覆盖。
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.videoCompose,
      position: { x: 0, y: 300 },
      data: {
        videoUrl: '/static/v.mp4',
        previewImageUrl: '/static/poster.png',
        aspectRatio: '16:9',
        durationSec: 5,
        widthPx: 1280,
        heightPx: 720,
        displayName: '成片视频',
      },
    },
    {
      // 普通 video 生成节点：详情挂生成表单，时长/分辨率由表单底部那行承载。
      id: 'vid-gen',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 200, y: 300 },
      data: {
        videoUrl: '/static/gen.mp4',
        aspectRatio: '16:9',
        durationSec: 4,
        widthPx: 1280,
        heightPx: 720,
        displayName: '生成视频',
      },
    },
  ];
  // 角色参考(上传图) → 成片视频：视频卡/详情的「参考素材」来源。
  const edges: CanvasEdge[] = [{ id: 'e1', source: 'ref-1', target: 'vid-1' }];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderBoard() {
  const onLocateNode = vi.fn();
  render(<AssetBoardView visible onLocateNode={onLocateNode} />);
  return { onLocateNode };
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

// jsdom 未实现 scrollIntoView：参考素材「定位」会在被引用卡片上调用它，
// 挂一个共享 mock 到原型，既避免报错也能断言「定位」触发了滚动。
const scrollIntoViewMock = vi.fn();

describe('AssetBoard 主从详情', () => {
  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    seedBoard();
  });

  it('点击图片卡 → 详情面板出现，另外两栏隐藏、只留被点栏窄列表', () => {
    renderBoard();
    expect(screen.getByText('文本')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));

    const detail = detailPanel();
    expect(within(detail).getByText('分镜草图')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '放大查看' })).toBeInTheDocument();
    expect(within(detail).getByText('九宫格铅笔线稿分镜草图')).toBeInTheDocument();
    // 详情面板不再提供「在画布中定位」入口（定位改走卡片 hover / 引用跳转）。
    expect(within(detail).queryByRole('button', { name: /在画布中定位/ })).not.toBeInTheDocument();
    // 图片栏窄列表保留，文本/视频栏消失。
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.queryByText('文本')).not.toBeInTheDocument();
    expect(screen.queryByText('视频')).not.toBeInTheDocument();
  });

  it('左栏点另一项 → 详情切换到该项', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    expect(within(detailPanel()).getByText('分镜草图')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '第二张图' }));

    const detail = detailPanel();
    expect(within(detail).getByText('第二张图')).toBeInTheDocument();
    expect(within(detail).queryByText('分镜草图')).not.toBeInTheDocument();
  });

  it('× 关闭详情 → 回三栏布局', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    expect(screen.queryByText('文本')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));

    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
    expect(screen.getByText('文本')).toBeInTheDocument();
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
  });

  it('Esc 关闭详情 → 回三栏布局', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    expect(screen.queryByRole('region', { name: '资产详情' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
  });

  it('文本卡点击 → 详情渲染完整文本内容（Markdown）', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '锚点清单' }));

    const detail = detailPanel();
    // 阅读页大标题 + markdown 渲染的标题/正文。
    expect(within(detail).getByRole('heading', { name: '锚点清单' })).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: '项目信息' })).toBeInTheDocument();
    expect(within(detail).getByText('品牌：光影')).toBeInTheDocument();
  });

  it('参考素材缩略图展开菜单 → 出现「编辑」「定位」两项', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));

    const referencesGroup = within(detailPanel()).getByRole('group', { name: '参考素材' });
    // 展开前无菜单项。
    expect(within(referencesGroup).queryByRole('menuitem', { name: '编辑' })).not.toBeInTheDocument();
    // 点击缩略图展开小菜单（hover 同源，走同一开合逻辑）。
    fireEvent.click(within(referencesGroup).getByRole('button', { name: '角色参考' }));
    expect(within(referencesGroup).getByRole('menuitem', { name: '编辑' })).toBeInTheDocument();
    expect(within(referencesGroup).getByRole('menuitem', { name: '定位' })).toBeInTheDocument();
  });

  it('参考素材菜单「编辑」→ 跨栏 push 被引用节点详情，← 返回原详情', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));
    expect(screen.getByText('视频')).toBeInTheDocument();
    expect(within(detailPanel()).getByText('成片视频')).toBeInTheDocument();

    // 参考素材缩略图展开菜单 →「编辑」→ push 被引用节点（上传图，图片栏）的详情。
    // 限定在「参考素材」这一组里找该缩略图（防御性作用域，避免与卡片内联缩略图重名）。
    const referencesGroup = within(detailPanel()).getByRole('group', { name: '参考素材' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: '角色参考' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: '编辑' }));
    expect(within(detailPanel()).getByText('角色参考')).toBeInTheDocument();
    // 左栏自动切到对应模块列表（视频 → 图片）。
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.queryByText('视频')).not.toBeInTheDocument();

    // ← 弹栈回上一个详情。
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(within(detailPanel()).getByText('成片视频')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
  });

  it('参考素材菜单「定位」（跨栏）→ 退回三栏总览并滚到被引用图片卡片', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));
    // 视频详情态：左侧只留视频窄列表，图片/文本栏不在。
    expect(screen.queryByText('图片')).not.toBeInTheDocument();

    const referencesGroup = within(detailPanel()).getByRole('group', { name: '参考素材' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: '角色参考' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: '定位' }));

    // 跨栏（视频 → 图片）→ 详情关闭、回三栏总览，且被引用卡片滚进视野。
    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('视频生成节点有上游引用 → 底部「参考素材」只读行不出现（引用改由视频表单 chip 承载）', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'v-ref',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/v-ref.png', aspectRatio: '1:1', displayName: '视频参考图' },
        },
        {
          // 普通 video 节点有生成表单 → !showGenerationForm 收掉底部只读行。
          id: 'v-gen',
          type: CANVAS_NODE_TYPES.video,
          position: { x: 0, y: 200 },
          data: { videoUrl: '/static/v-gen.mp4', aspectRatio: '16:9', displayName: '生成视频' },
        },
      ],
      [{ id: 'e-vref', source: 'v-ref', target: 'v-gen' }],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    // 生成表单在场 → 无底部只读「参考素材」组（引用只由表单里的引用 chip 呈现，不重复）。
    expect(within(detailPanel()).queryByRole('group', { name: '参考素材' })).not.toBeInTheDocument();
  });

  it('参考素材菜单「定位」（同栏）→ 保留详情，滚动窄列表到被引用卡片', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'loc-a',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/loc-a.png', aspectRatio: '1:1', displayName: '定位图A' },
        },
        {
          id: 'loc-b',
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 200, y: 0 },
          data: { imageUrl: '/static/loc-b.png', aspectRatio: '1:1', displayName: '定位图B' },
        },
      ],
      // 图B（上传）→ 图A：图A 详情的「参考素材」来源，与图A 同在图片栏。
      [{ id: 'e-b-a', source: 'loc-b', target: 'loc-a' }],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '定位图A' }));

    const referencesGroup = within(detailPanel()).getByRole('group', { name: '参考素材' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: '定位图B' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: '定位' }));

    // 同栏（图片 → 图片）→ 详情保持打开，窄列表里的被引用卡片滚进视野。
    expect(screen.getByRole('region', { name: '资产详情' })).toBeInTheDocument();
    expect(within(detailPanel()).getByText('定位图A')).toBeInTheDocument();
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it('A→B→A 互相引用 → 详情栈按 (column, nodeId) 去重收敛为深度 1，← 直接关闭', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'mut-a',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/a.png', aspectRatio: '1:1', displayName: '互引A' },
        },
        {
          id: 'mut-b',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 200, y: 0 },
          data: { imageUrl: '/static/b.png', aspectRatio: '1:1', displayName: '互引B' },
        },
      ],
      [
        // A 的「参考素材」来自其上游 B；B 的「参考素材」来自其上游 A —— 互相引用。
        { id: 'e-b-to-a', source: 'mut-b', target: 'mut-a' },
        { id: 'e-a-to-b', source: 'mut-a', target: 'mut-b' },
      ],
    );
    renderBoard();
    // 卡片本身也会内联展示参考素材缩略图（AssetBoardCard），互相引用时 B 卡片上
    // 会出现一个 aria-label="互引A" 的参考缩略图按钮，与 A 卡片标题按钮同名——
    // 用 getByText 精确定位标题按钮（纯文本子节点），避开这个按钮级重名。
    fireEvent.click(screen.getByText('互引A'));
    expect(within(detailPanel()).getByText('互引A')).toBeInTheDocument();

    // A → B：参考素材菜单「编辑」→ push，栈深变 2。
    const groupA = within(detailPanel()).getByRole('group', { name: '参考素材' });
    fireEvent.click(within(groupA).getByRole('button', { name: '互引B' }));
    fireEvent.click(within(groupA).getByRole('menuitem', { name: '编辑' }));
    expect(within(detailPanel()).getByText('互引B')).toBeInTheDocument();

    // B → A：A 已经在栈里出现过（栈底那一层）→ 截断回那一层，而不是再 push 一层。
    const groupB = within(detailPanel()).getByRole('group', { name: '参考素材' });
    fireEvent.click(within(groupB).getByRole('button', { name: '互引A' }));
    fireEvent.click(within(groupB).getByRole('menuitem', { name: '编辑' }));
    expect(within(detailPanel()).getByText('互引A')).toBeInTheDocument();

    // 栈深已收敛为 1：← 直接关闭详情回三栏（不会先弹回 B）。
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
    expect(screen.getByText('图片')).toBeInTheDocument();
  });

  it('← 在栈深 1 时关闭详情 → 回三栏布局', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    expect(screen.queryByRole('region', { name: '资产详情' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回' }));

    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
    expect(screen.getByText('文本')).toBeInTheDocument();
    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
  });

  it('详情打开期间节点被删除 → 显示「节点已不存在」空态', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    expect(within(detailPanel()).getByText('分镜草图')).toBeInTheDocument();

    act(() => {
      const state = useCanvasStore.getState();
      state.setCanvasData(
        state.nodes.filter((node) => node.id !== 'img-1'),
        state.edges,
      );
    });

    expect(within(detailPanel()).getByText('节点已不存在')).toBeInTheDocument();
    expect(within(detailPanel()).queryByText('分镜草图')).not.toBeInTheDocument();
  });

  it('生成中节点 → 详情媒体区显示生成中占位（不渲染大图）', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'gen-1',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          // generationTaskKey：setCanvasData 会把没有可恢复句柄的 isGenerating 归零
          //（防中断任务永转），带上任务句柄才能保留生成中态。
          data: {
            imageUrl: null,
            isGenerating: true,
            generationTaskKey: 'task-1',
            aspectRatio: '1:1',
            displayName: '生成中图片',
          },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '生成中图片' }));

    const detail = detailPanel();
    // 未给 generationStartedAt → 估算 hook 退化为「从挂载时刻计时」，渲染瞬间 0%。
    expect(within(detail).getByText('生成中 0%...')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '放大查看' })).not.toBeInTheDocument();
  });

  it('生成中且已有媒体（重新生成）→ 保留原图渲染并叠加生成中遮罩', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'regen-1',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: {
            imageUrl: '/static/regen.png',
            isGenerating: true,
            generationTaskKey: 'task-2',
            aspectRatio: '1:1',
            displayName: '重生成图片',
          },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '重生成图片' }));

    const detail = detailPanel();
    // 旧图不被生成中态顶掉（重新生成原地保留旧 url），遮罩叠加其上。
    expect(within(detail).getByAltText('重生成图片')).toBeInTheDocument();
    expect(within(detail).getByRole('status', { name: '生成中' })).toBeInTheDocument();
    // 重新生成走 GeneratingOverlay（纯 spinner，不带百分比文案）——占位分支的
    // 「生成中 X%...」文案不会跟遮罩一起出现。
    expect(within(detail).queryByText(/^生成中 \d+%\.\.\.$/)).not.toBeInTheDocument();
    // 生成中禁止放大查看（键盘路径也一并挡住，而不只是视觉上盖一层遮罩）。
    expect(within(detail).getByRole('button', { name: '放大查看' })).toBeDisabled();
  });

  it('失败节点 → 详情头部下方显示红色错误条', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'err-1',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: {
            imageUrl: '/static/err.png',
            generationError: '算力不足，生成失败',
            aspectRatio: '1:1',
            displayName: '失败图片',
          },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '失败图片' }));

    expect(within(detailPanel()).getByText('算力不足，生成失败')).toBeInTheDocument();
  });

  it('点击卡片不触发 onLocateNode；详情面板不再提供「在画布中定位」入口', () => {
    const { onLocateNode } = renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '锚点清单' }));
    expect(onLocateNode).not.toHaveBeenCalled();

    // 定位按钮已从详情面板整体移除（四类详情：文本/图片/视频/音频）；
    // 定位改走卡片 hover 的准星按钮，与本详情面板无关。
    expect(within(detailPanel()).queryByRole('button', { name: /在画布中定位/ })).not.toBeInTheDocument();
    expect(onLocateNode).not.toHaveBeenCalled();
  });
});

describe('AssetBoard 详情态左窄列表切栏下拉', () => {
  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
    seedBoard();
  });

  function openSwitcher(currentLabel: string): HTMLElement {
    // 头部下拉触发器 = 当前栏中文名（button，无 aria-label→可名字定位）。
    fireEvent.click(screen.getByRole('button', { name: currentLabel }));
    return screen.getByRole('menu', { name: '切换栏目' });
  }

  it('图片详情左列表头部是切栏下拉：展开出「文本/图片/视频」三项，当前「图片」打勾', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));

    const trigger = screen.getByRole('button', { name: '图片' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    // 展开前无菜单项。
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();

    const menu = openSwitcher('图片');
    expect(within(menu).getByRole('menuitemradio', { name: '文本' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: '图片' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: '视频' })).toBeInTheDocument();
    // 当前显示的栏（图片）打勾（✓），其余不打勾。
    expect(within(menu).getByRole('menuitemradio', { name: '图片', checked: true })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: '文本', checked: false })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: '视频', checked: false })).toBeInTheDocument();
  });

  it('切到「视频」→ 左列表换成视频卡片，右侧详情仍是原图片（不随切栏而变）', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    // 右侧详情 = 分镜草图；左列表当前是图片栏（有另一张图片卡）。
    expect(within(detailPanel()).getByText('分镜草图')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第二张图' })).toBeInTheDocument();

    fireEvent.click(within(openSwitcher('图片')).getByRole('menuitemradio', { name: '视频' }));

    // 左列表换成视频卡片，图片卡消失，触发器变「视频」。
    expect(screen.getByRole('button', { name: '成片视频' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '第二张图' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '视频' })).toBeInTheDocument();
    // 右侧详情不变（切栏只改左侧浏览的列表）。
    expect(within(detailPanel()).getByText('分镜草图')).toBeInTheDocument();
  });

  it('切栏后点左列表某卡 → 打开该节点详情，左列表跟随到该卡所在栏', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '分镜草图' }));
    // 在图片详情里把左列表切到视频浏览。
    fireEvent.click(within(openSwitcher('图片')).getByRole('menuitemradio', { name: '视频' }));

    // 点左列表的视频卡 → 打开该视频详情。
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));
    expect(within(detailPanel()).getByText('成片视频')).toBeInTheDocument();
    // 「点了哪栏的卡片，左列表就是哪栏」：仍是视频栏（触发器「视频」+ 视频卡在左列表）。
    expect(screen.getByRole('button', { name: '视频' })).toBeInTheDocument();
  });

  it('切栏后从右侧参考跳转 push 新详情 → 左列表重置为新详情所在栏', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));
    // 手动把左列表从「视频」切到「文本」浏览。
    fireEvent.click(within(openSwitcher('视频')).getByRole('menuitemradio', { name: '文本' }));
    expect(screen.getByRole('button', { name: '文本' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '锚点清单' })).toBeInTheDocument();

    // 右侧视频详情的参考素材「编辑」→ push 被引用图片（角色参考）的详情。
    const referencesGroup = within(detailPanel()).getByRole('group', { name: '参考素材' });
    fireEvent.click(within(referencesGroup).getByRole('button', { name: '角色参考' }));
    fireEvent.click(within(referencesGroup).getByRole('menuitem', { name: '编辑' }));

    // 新详情 = 角色参考（图片栏）→ 左列表重置为图片（不再停留在用户之前选的文本）。
    expect(within(detailPanel()).getByText('角色参考')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '图片' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '锚点清单' })).not.toBeInTheDocument();
  });

  it('空态：切到无卡片的栏显示该栏空态文案', () => {
    // 只有图片节点：切到文本/视频栏应显示对应空态。
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'only-img',
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 0, y: 0 },
          data: { imageUrl: '/static/only.png', aspectRatio: '1:1', displayName: '唯一图片' },
        },
      ],
      [],
    );
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '唯一图片' }));

    fireEvent.click(within(openSwitcher('图片')).getByRole('menuitemradio', { name: '视频' }));
    expect(screen.getByText('画布中还没有视频节点')).toBeInTheDocument();

    fireEvent.click(within(openSwitcher('视频')).getByRole('menuitemradio', { name: '文本' }));
    expect(screen.getByText('画布中还没有文本类节点')).toBeInTheDocument();
  });

  it('挂了生成表单的视频详情不再重复渲染时长/分辨率徽标（表单底部那行已经写了）', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    const detail = detailPanel();
    expect(within(detail).queryByText('4秒')).not.toBeInTheDocument();
    expect(within(detail).queryByText('1280 × 720')).not.toBeInTheDocument();
  });

  it('无生成表单的视频详情（成片）仍显示时长/分辨率徽标——那里是唯一出处', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));

    const detail = detailPanel();
    expect(within(detail).getByText('5秒')).toBeInTheDocument();
    expect(within(detail).getByText('1280 × 720')).toBeInTheDocument();
  });
});
