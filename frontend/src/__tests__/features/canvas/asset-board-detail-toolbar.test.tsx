// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { __resetAssetBoardImageOpsStateForTest } from '@/features/canvas/ui/asset-board/AssetBoardImageEditMenu';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// 点音频 chip 打开详情会挂波形播放器：需 ResizeObserver + canvas 2D 上下文，
// 且解码 fetch(src) 挂起不 settle（否则测试结束后 console.warn 触发拆除报错）。
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);
HTMLCanvasElement.prototype.getContext = vi.fn(
  () => null,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

// ImageViewerModal / 详情工具条依赖 useTranslation（VideoComposeModal 等）。
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

// busy 态隔离测试用：返回可控的 { nodeId, completion }，避免真实全景生成链（网络）。
const scene360ImageMock = vi.hoisted(() => vi.fn());
vi.mock('@/features/canvas/application/imageScene360', () => ({
  scene360Image: scene360ImageMock,
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
      data: { content: '原始内容', displayName: '锚点清单' },
    },
    {
      // 第二个文本节点：详情切换到另一节点时用于验证正文按 node.id 更新的目标。
      id: 'text-2',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 200, y: 0 },
      data: { content: '乙内容', displayName: '第二清单' },
    },
    {
      // upload 节点：图片工具条完整形态（imageEdit 会按工作流语义隐藏编辑类操作）。
      id: 'img-up',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 100 },
      data: { imageUrl: '/static/up.png', aspectRatio: '1:1', displayName: '上传图' },
    },
    {
      // 第二个图片节点：busy 态跨节点错位回归用例的切换目标。
      id: 'img-up-2',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 200, y: 100 },
      data: { imageUrl: '/static/up2.png', aspectRatio: '1:1', displayName: '第二上传图' },
    },
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 300 },
      data: {
        videoUrl: '/static/v.mp4',
        prompt: '一个镜头',
        aspectRatio: '16:9',
        displayName: '成片视频',
      },
    },
    {
      // 空内容节点（参数就位、还没提交生成）：工具条整条不该渲染。
      id: 'vid-empty',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 400, y: 300 },
      data: { prompt: '还没生成', aspectRatio: '16:9', displayName: '空视频' },
    },
    {
      id: 'img-empty',
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 400, y: 100 },
      data: { prompt: '还没生成', aspectRatio: '1:1', displayName: '空图片' },
    },
    {
      // 生成失败的视频：没片源，但「历史」里可能有上一次成功的结果 → 工具条要留着。
      id: 'vid-failed',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 600, y: 300 },
      data: {
        prompt: '失败的镜头',
        aspectRatio: '16:9',
        displayName: '失败视频',
        generationError: '算力不足，生成失败',
      },
    },
    {
      // 音频节点：四栏详情头部都挂「节点操作」菜单的用例要用。
      id: 'aud-1',
      type: CANVAS_NODE_TYPES.audio,
      position: { x: 0, y: 500 },
      data: { audioUrl: '/static/bgm.mp3', displayName: '背景音乐' },
    },
  ];
  const edges: CanvasEdge[] = [];
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

// 编辑三项（高清/裁剪/旋转）住在「...」更多菜单里——先展开它。
// （宫格模板是常显工具条上的独立下拉，不在此菜单内。）
function openMoreMenu(detail: HTMLElement) {
  fireEvent.click(within(detail).getByRole('button', { name: '更多' }));
}

describe('AssetBoard 详情工具条（第一批装配）', () => {
  beforeEach(() => {
    scene360ImageMock.mockReset();
    // busy 登记表是模块级的（跨重挂载存活），用例间不清会串态。
    __resetAssetBoardImageOpsStateForTest();
    seedBoard();
  });

  it('图片详情：常显 下载/全景/多角度/重打光/宫格模板，编辑三项收进「...」更多菜单', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));

    const detail = detailPanel();
    // 常显项直接可见（宫格模板已从「...」挪到常显下拉）。
    for (const label of ['下载', '全景', '多角度', '重打光', '宫格模板', '更多']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 「编辑」下拉已删除，它的三项就是现在「...」里的内容。
    expect(within(detail).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    // 收进「...」的项在展开前不可见。
    for (const label of ['高清', '裁剪', '旋转']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // 展开「...」更多菜单后，这些项可达。
    openMoreMenu(detail);
    for (const label of ['高清', '裁剪', '旋转']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 用户拍板移除的旧菜单项（能力仍在工作流侧 NodeActionToolbar）一个都不该在。
    for (const label of ['抠图', '标注', '分格抽取', '历史']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    // 上传图节点没有可重试的生成 payload → 不显示重新生成。
    expect(within(detail).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument();
  });

  it('图片详情：常显「宫格模板」下拉展开 9 个模板项', async () => {
    const user = userEvent.setup();
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));

    const detail = detailPanel();
    // 展开前子模板不可见。
    expect(screen.queryByRole('menuitem', { name: /多机位九宫格/ })).not.toBeInTheDocument();
    // 点常显「宫格模板」下拉（Radix 菜单 portal 到 body，项走 menuitem 角色）。
    await user.click(within(detail).getByRole('button', { name: '宫格模板' }));
    for (const label of ['多机位九宫格', '剧情推演四宫格', '25宫格连贯分镜']) {
      expect(await screen.findByRole('menuitem', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('图片详情头部「节点操作」→ 设置关键元素 → 人物 写入标记，可再取消清空', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));

    // 关键元素入口统一在详情头部那颗「...」，不在工具条的「更多」里。
    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: '节点操作' }));
    fireEvent.click(within(header).getByRole('button', { name: /设置关键元素/ }));
    // 二级菜单 portal 到 body（要浮在右侧对话抽屉之上），所以从 screen 上找子项。
    fireEvent.click(screen.getByRole('button', { name: '人物' }));
    expect(
      useCanvasStore.getState().nodes.find((n) => n.id === 'img-up')?.data.keyElementCategory,
    ).toBe('character');

    // 标记后子菜单标题变成「关键元素 · 人物」，并多出「取消关键元素」。点它清空。
    fireEvent.click(screen.getByRole('button', { name: '取消关键元素' }));
    expect(
      useCanvasStore.getState().nodes.find((n) => n.id === 'img-up')?.data.keyElementCategory,
    ).toBeNull();
  });

  it('工具条的「更多」不再重复挂「设置关键元素」（它已统一到头部）', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));

    const detail = detailPanel();
    openMoreMenu(detail);
    expect(within(detail).queryByRole('button', { name: /设置关键元素/ })).not.toBeInTheDocument();
  });

  it('视频详情：只剩 剪辑/高清/下载/全屏 四项；高清展开配置浮层', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));

    const detail = detailPanel();
    for (const label of ['剪辑', '高清', '下载', '全屏']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 其余视频功能已从故事板移除（用户要求砍到四项）。
    for (const label of [
      '智能去字幕',
      '翻译提示词',
      '历史',
      '剪辑轨道',
      '解析',
      '分离音视频',
      '截帧',
      '替换视频',
      '框选擦除',
    ]) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }

    fireEvent.click(within(detail).getByRole('button', { name: '高清' }));
    expect(within(detail).getByText('分辨率')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '2K' })).toBeInTheDocument();
    expect(within(detail).getByText('降噪')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: '提交高清' })).toBeInTheDocument();
  });

  it('空内容视频节点（还没出片）：整条工具条不渲染', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '空视频' }));

    const detail = detailPanel();
    for (const label of ['剪辑', '高清', '下载', '全屏']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('空内容图片节点（还没出图）：整条工具条不渲染', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '空图片' }));

    const detail = detailPanel();
    expect(within(detail).queryByRole('button', { name: '下载' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '更多' })).not.toBeInTheDocument();
  });

  it('生成失败的视频节点：工具条不渲染（四项操作全要片源，摆一排灰按钮只是噪音）', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '失败视频' }));

    const detail = detailPanel();
    // 失败原因仍由头部下方的红色横条给出（见 AssetBoardDetail）。
    expect(within(detail).getByText('算力不足，生成失败')).toBeInTheDocument();
    for (const label of ['剪辑', '高清', '下载', '全屏']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('有片源的视频节点仍照常出工具条（空态判定不误伤已出片的）', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));
    expect(within(detailPanel()).getByRole('button', { name: '下载' })).toBeInTheDocument();
  });

  it('视频详情头部「...」：设置关键元素（写分类，可取消）/ 创建副本 / 删除', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '空视频' }));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: '节点操作' }));
    for (const label of ['设置关键元素', '创建副本', '删除']) {
      expect(within(header).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }

    // 展开子菜单选「人物」→ 写节点标记；菜单标题随之变成「关键元素 · 人物」。
    // 子项从 screen 找而不是 within(header)：飞出的二级面板 portal 到了 body（不这么做
    // 会被右侧对话抽屉盖住，见 DetailMoreMenu 的 placeSubmenu），DOM 上不在头部子树里。
    fireEvent.click(within(header).getByRole('button', { name: /设置关键元素/ }));
    fireEvent.click(screen.getByRole('button', { name: '人物' }));
    expect(
      useCanvasStore.getState().nodes.find((n) => n.id === 'vid-empty')?.data.keyElementCategory,
    ).toBe('character');
    expect(within(header).getByRole('button', { name: /关键元素 · 人物/ })).toBeInTheDocument();
  });

  it('视频详情头部「...」→ 创建副本：克隆节点并把详情切到副本', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '成片视频' }));
    const idsBefore = new Set(useCanvasStore.getState().nodes.map((n) => n.id));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: '节点操作' }));
    fireEvent.click(within(header).getByRole('button', { name: '创建副本' }));

    const clone = useCanvasStore.getState().nodes.find((n) => !idsBefore.has(n.id));
    expect(clone).toBeDefined();
    // 详情确实切到了副本：头部标题显示副本自己的名字（副本会重新发号，与源不同名）。
    // 只断言「详情面板还在」是无效断言——详情本来就开着，恒真会放过「点了没反应」。
    expect(within(detailPanel()).getByRole('heading')).toHaveTextContent(
      String((clone?.data as { displayName?: string }).displayName),
    );
  });

  it('视频详情头部「...」→ 删除：节点移出画布且详情关闭', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '空视频' }));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: '节点操作' }));
    fireEvent.click(within(header).getByRole('button', { name: '删除' }));

    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'vid-empty')).toBeUndefined();
    expect(screen.queryByRole('region', { name: '资产详情' })).not.toBeInTheDocument();
  });

  it.each([
    ['文本', '锚点清单'],
    ['图片', '上传图'],
    ['视频', '成片视频'],
    ['音频', '背景音乐'],
  ])('%s详情头部都挂「节点操作」菜单（四栏一致）', (_column, cardName) => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: cardName }));

    const header = within(detailPanel()).getByRole('banner', { hidden: true });
    fireEvent.click(within(header).getByRole('button', { name: '节点操作' }));
    for (const label of ['设置关键元素', '创建副本', '删除']) {
      expect(within(header).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('文本详情：只读展示，不提供「编辑」「翻译」入口', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '锚点清单' }));

    const detail = detailPanel();
    expect(within(detail).getByText('原始内容')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '翻译' })).not.toBeInTheDocument();
    expect(within(detail).queryByPlaceholderText('输入文本内容…')).not.toBeInTheDocument();
  });

  it('切换详情项 → 文本正文按 node.id 更新，不残留上一个节点内容', () => {
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '锚点清单' }));

    let detail = detailPanel();
    expect(within(detail).getByText('原始内容')).toBeInTheDocument();

    // 左列切到另一个文本详情：key={node.id} 应强制换实例。
    fireEvent.click(screen.getByRole('button', { name: '第二清单' }));

    detail = detailPanel();
    expect(within(detail).queryByText('原始内容')).not.toBeInTheDocument();
    expect(within(detail).getByText('乙内容')).toBeInTheDocument();

    // B 的 content 未被 A 的内容残留覆盖。
    const nodeB = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'text-2');
    expect(nodeB?.data).toMatchObject({ content: '乙内容' });
  });

  it('切换详情项 → 工具条 busy 态复位（A 的全景 spinner 不带到 B）', () => {
    // completion 永不 settle：A 的全景停留在 busy 态。
    scene360ImageMock.mockReturnValue({
      nodeId: 'pano-result',
      completion: new Promise(() => {}),
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: '全景' }));
    expect(scene360ImageMock).toHaveBeenCalledWith('img-up', '/static/up.png', {
      displayName: '360°全景图',
      aspectRatio: '2:1',
    });
    expect(within(detailPanel()).getByRole('button', { name: '全景' })).toBeDisabled();

    // 切到另一张图：busy 登记表按 nodeId 记，B 不该继承 A 的 busy 态。
    fireEvent.click(screen.getByRole('button', { name: '第二上传图' }));
    expect(within(detailPanel()).getByRole('button', { name: '全景' })).not.toBeDisabled();
    confirmSpy.mockRestore();
  });

  it('音频 chip：点击打开详情（不再定位），右侧出现下载按钮', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'aud-1',
        type: CANVAS_NODE_TYPES.audio,
        position: { x: 0, y: 0 },
        data: { audioUrl: '/static/bg.mp3', displayName: '背景音' },
      },
    ];
    useCanvasStore.getState().setCanvasData(nodes, []);
    const onLocateNode = vi.fn();
    render(<AssetBoardView visible onLocateNode={onLocateNode} />);

    // 三栏态：顶部音频条 chip 旁有下载按钮（精确名只命中 chip，下载名为「下载 背景音」）。
    expect(screen.getByRole('button', { name: '下载 背景音' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '背景音' }));
    // 主体点击改为打开详情（波形 + 生成表单），不再直接定位。
    expect(detailPanel()).toBeInTheDocument();
    expect(within(detailPanel()).getByRole('slider', { name: 'Audio waveform scrubber' })).toBeInTheDocument();
    expect(onLocateNode).not.toHaveBeenCalled();
  });
});
