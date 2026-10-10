// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  __resetAssetBoardImageOpsStateForTest,
  inFlightImageOps,
} from '@/features/canvas/ui/asset-board/AssetBoardImageEditMenu';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

// MultiAngleEditorPanel / LightEditorPanel 内部的 Radix Slider 依赖
// ResizeObserver（@radix-ui/react-use-size），jsdom 没有实现，同
// editor-content-split.test.tsx / canvas-skill-manual-connect.test.tsx 的兜底。
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

// 详情工具条的活价查询没有 QueryClientProvider —— mock 掉走硬编码兜底。
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
// 模型清单同样走网络，给一个确定的首选模型。
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  isAuthoritativeEmptyCatalog: () => false,
  useFreezoneImageModels: () => ({
    models: [{ id: 'huimeng/gpt-image-2', apiModel: 'gpt-image-2', label: 'GPT Image 2' }],
  }),
}));

// 第二批操作的编排函数：验证「选参数 → 提交」把正确入参传下去，并用永不 settle 的
// completion 保持 busy 态可断言。
const scene360Image = vi.hoisted(() => vi.fn());
const multiAngleImage = vi.hoisted(() => vi.fn());
const relightImage = vi.hoisted(() => vi.fn());
const createUpscaleResultNode = vi.hoisted(() => vi.fn());
const submitImageUpscale = vi.hoisted(() => vi.fn());
const createRotateResultNode = vi.hoisted(() => vi.fn());
const discardRotateResultNode = vi.hoisted(() => vi.fn());
const rotateImageInPlace = vi.hoisted(() => vi.fn());
const createCropResultNode = vi.hoisted(() => vi.fn());
const discardCropResultNode = vi.hoisted(() => vi.fn());
const cropImageInPlace = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/imageScene360', () => ({ scene360Image }));
vi.mock('@/features/canvas/application/imageMultiAngle', () => ({ multiAngleImage }));
vi.mock('@/features/canvas/application/imageRelight', () => ({ relightImage }));
vi.mock('@/features/canvas/application/imageUpscale', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createUpscaleResultNode,
  submitImageUpscale,
}));
// 旋转只 mock 三个副作用函数，isIdentityRotateTransform 保持真实——旋转编辑器
// 「没做任何变换就保存」的分支正是靠它判定的。
vi.mock('@/features/canvas/application/imageRotate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRotateResultNode,
  discardRotateResultNode,
  rotateImageInPlace,
}));
// 裁剪同理：只 mock 三个副作用函数，比例换算 / 取景框复位 / 整图判定保持真实——
// 「换比例后取景框落在哪」「没动取景框就确认」两条断言正是靠它们成立的。
vi.mock('@/features/canvas/application/imageCrop', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createCropResultNode,
  discardCropResultNode,
  cropImageInPlace,
}));

const NEVER = new Promise<void>(() => {});

function seedBoard(extraData: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [
    {
      id: 'img-up',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: {
        imageUrl: '/static/up.png',
        aspectRatio: '1:1',
        displayName: '上传图',
        ...extraData,
      },
    } as CanvasNode,
    {
      // imageEdit 节点：按工作流语义不给图片编辑入口。
      id: 'img-edit',
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 200, y: 0 },
      data: { imageUrl: '/static/edit.png', displayName: '改图节点' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

/** 「编辑 → 高清」预建出来的结果节点 id，由 seedUpscaleResultNode 写入供断言取用。 */
let upscaleResultNodeId = '';

/**
 * 还原 createUpscaleResultNode 的真实副作用：在 store 里建出 resultKind:'upscale'
 * 的结果节点（未提交，previewImageUrl 就是待放大的源图）。编排函数被 mock 掉之后
 * 仍然需要这个节点真实存在，详情才切得过去、下方的高清编辑器才有 data 可读可写。
 */
function seedUpscaleResultNode(): string {
  upscaleResultNodeId = useCanvasStore.getState().addNode(
    CANVAS_NODE_TYPES.exportImage,
    { x: 320, y: 0 },
    {
      displayName: '高清放大',
      imageUrl: null,
      previewImageUrl: '/static/up.png',
      resultKind: 'upscale',
      isGenerating: false,
      upscaleSourceUrl: '/static/up.png',
      upscaleModelId: 'huimeng/gpt-image-2',
    } as never,
  );
  return upscaleResultNodeId;
}

function detailPanel() {
  return screen.getByRole('region', { name: '资产详情' });
}

/**
 * 让裁剪编辑器里的那张图「加载完成」。jsdom 不会真的解码图片（onLoad 不触发、
 * naturalWidth 恒为 0），而取景框的坐标全按自然像素算——所以这里手动补上尺寸再
 * 派发 load，否则编辑器永远停在「还没量到图」的状态、取景框根本不渲染。
 */
function loadCropImage(dialog: HTMLElement, width: number, height: number) {
  const img = dialog.querySelector('img');
  expect(img).not.toBeNull();
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(img as HTMLImageElement);
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name }));
}

/**
 * 展开工具条最右那颗「...」更多菜单（编辑三项：高清/裁剪/旋转 住在里面）。
 *
 * - 用 fireEvent.click 而不是 user.click：菜单以 hover 为主（wrapper 上挂着
 *   onMouseEnter → 打开），userEvent 的 click 会先派发 mouseenter 把它打开、
 *   随后的 click 又被当成「再点一次」收起来。fireEvent 只发 click，语义干净。
 * - 按 aria-expanded 判重：点开过一次后叶子项点击不会自动收起（悬停菜单惯例），
 *   这时再盲点一次反而是关掉它。
 */
function openMoreMenu(): HTMLElement {
  const detail = detailPanel();
  const trigger = within(detail).getByRole('button', { name: '更多' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return detail;
}

describe('AssetBoard 详情图片操作（第二批：「...」编辑三项 + 全景/多角度/重打光）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAssetBoardImageOpsStateForTest();
    upscaleResultNodeId = '';
    seedBoard();
  });

  it('渲染 全景/多角度/重打光 入口；「...」菜单含高清/裁剪/旋转三项', () => {
    openDetail('上传图');

    const detail = detailPanel();
    for (const label of ['全景', '多角度', '重打光']) {
      expect(within(detail).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // 「编辑」下拉已删除（用户要求），三项搬进了最右那颗「...」。
    expect(within(detail).queryByRole('button', { name: /编辑/ })).not.toBeInTheDocument();

    openMoreMenu();
    for (const label of ['高清', '裁剪', '旋转']) {
      expect(within(detail).getByRole('button', { name: label })).toBeInTheDocument();
    }
    // 重绘 / 擦除要在图上刷蒙版，故事板详情不做；扩图被用户拍板去掉（位置让给裁剪）。
    for (const label of ['重绘', '擦除', '扩图']) {
      expect(within(detail).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('preset_managed（主线投影锁定）节点：「...」隐藏高清与旋转，裁剪保留', () => {
    seedBoard({ preset_managed: true });
    openDetail('上传图');

    const detail = openMoreMenu();
    // 裁剪 spawn 出的是 user_spawned 子节点，锁定态下照常可用。
    expect(within(detail).getByRole('button', { name: '裁剪' })).toBeInTheDocument();
    // 原地改写源图的两项被过滤（同工作流 NodeActionToolbar 语义）。
    expect(within(detail).queryByRole('button', { name: '高清' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: '旋转' })).not.toBeInTheDocument();
  });

  it('旋转：「...」进入实时预览编辑器 → 转 180° → 保存写回预建的结果节点', async () => {
    const user = userEvent.setup();
    createRotateResultNode.mockReturnValue('rot-1');
    rotateImageInPlace.mockReturnValue(NEVER);
    openDetail('上传图');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: '旋转' }));

    // 进编辑器就把「旋转结果」节点建好（源图保持不动），编辑器直接写回它。
    expect(createRotateResultNode).toHaveBeenCalledWith('img-up', { displayName: '旋转结果' });

    const dialog = await screen.findByRole('dialog', { name: 'rotateEditor.title' });
    const preview = dialog.querySelector('img');
    expect(preview).not.toBeNull();
    expect(preview?.style.transform).toBe('rotate(0deg) scale(1, 1)');

    // 每点一次「顺时针 90°」都在当前角度上加 90，预览实时跟着变（libtv 行为）。
    const rotate90 = within(dialog).getByRole('button', { name: 'rotateEditor.rotate90' });
    await user.click(rotate90);
    await user.click(rotate90);
    expect(preview?.style.transform).toBe('rotate(180deg) scale(1, 1)');

    await user.click(within(dialog).getByRole('button', { name: /rotateEditor\.save/ }));

    expect(rotateImageInPlace).toHaveBeenCalledWith('rot-1', expect.stringContaining('up.png'), {
      angleDeg: 180,
      mirrorH: false,
      mirrorV: false,
    });
    // 提交后编辑器关闭，源节点的「...→旋转」进入 busy 直到后台链 settle。
    expect(screen.queryByRole('dialog', { name: 'rotateEditor.title' })).not.toBeInTheDocument();
    expect(inFlightImageOps.get('img-up')).toBe('rotate');
    expect(discardRotateResultNode).not.toHaveBeenCalled();
  });

  it('旋转：直接退出不提交，预建的结果节点被回收', async () => {
    const user = userEvent.setup();
    createRotateResultNode.mockReturnValue('rot-2');
    openDetail('上传图');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: '旋转' }));

    const dialog = await screen.findByRole('dialog', { name: 'rotateEditor.title' });
    await user.click(within(dialog).getByRole('button', { name: 'rotateEditor.exit' }));

    expect(rotateImageInPlace).not.toHaveBeenCalled();
    expect(discardRotateResultNode).toHaveBeenCalledWith('rot-2');
    expect(screen.queryByRole('dialog', { name: 'rotateEditor.title' })).not.toBeInTheDocument();
    expect(inFlightImageOps.get('img-up')).toBeUndefined();
  });

  it('imageEdit 节点：不给第二批图片操作入口', () => {
    openDetail('改图节点');
    const detail = detailPanel();
    // 编辑三项没图可编辑 → 「...」整颗不渲染（否则点开是个空面板）。
    expect(within(detail).queryByRole('button', { name: '更多' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /全景/ })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /多角度/ })).not.toBeInTheDocument();
  });

  it('裁剪：「...」进入取景编辑器 → 换比例 → 确认，取景框按自然像素写回预建的结果节点', async () => {
    const user = userEvent.setup();
    createCropResultNode.mockReturnValue('crop-1');
    cropImageInPlace.mockReturnValue(NEVER);
    openDetail('上传图');

    const detail = openMoreMenu();
    fireEvent.click(within(detail).getByRole('button', { name: '裁剪' }));

    // 进编辑器就把「裁剪结果」节点建好（源图保持不动），编辑器直接写回它。
    expect(createCropResultNode).toHaveBeenCalledWith('img-up', { displayName: '裁剪结果' });

    const dialog = await screen.findByRole('dialog', { name: 'cropEditor.title' });
    loadCropImage(dialog, 800, 400);

    // 默认是「原图比例」；换成 1:1 后取景框复位成该比例下的最大居中矩形
    // （800×400 里的 400×400，居中即 x=200）。
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.aspectOriginal' }));
    await user.click(await within(dialog).findByRole('option', { name: /1:1/ }));
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.confirm' }));

    expect(cropImageInPlace).toHaveBeenCalledWith('crop-1', '/static/up.png', {
      x: 200,
      y: 0,
      width: 400,
      height: 400,
    });
    // 提交后编辑器关闭，源节点的「...→裁剪」进入 busy 直到后台链 settle。
    expect(screen.queryByRole('dialog', { name: 'cropEditor.title' })).not.toBeInTheDocument();
    expect(within(openMoreMenu()).getByRole('button', { name: '裁剪' })).toBeDisabled();
    expect(inFlightImageOps.get('img-up')).toBe('crop');
    expect(discardCropResultNode).not.toHaveBeenCalled();
    // 结果节点已请求视口预定位（Task 10 模式）。
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('crop-1');
  });

  it('裁剪：退出 / 没动取景框就确认，都视作未提交并回收预建的结果节点', async () => {
    const user = userEvent.setup();
    createCropResultNode.mockReturnValue('crop-2');
    openDetail('上传图');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: '裁剪' }));
    let dialog = await screen.findByRole('dialog', { name: 'cropEditor.title' });
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.exit' }));

    expect(cropImageInPlace).not.toHaveBeenCalled();
    expect(discardCropResultNode).toHaveBeenCalledWith('crop-2');
    expect(screen.queryByRole('dialog', { name: 'cropEditor.title' })).not.toBeInTheDocument();
    expect(inFlightImageOps.get('img-up')).toBeUndefined();

    // 再进一次，什么都不动直接确认：取景框还是整张图，没什么可裁的——不上传、
    // 同样回收预建节点，免得画布上多出一个与原图逐像素相同的副本。
    createCropResultNode.mockReturnValue('crop-3');
    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: '裁剪' }));
    dialog = await screen.findByRole('dialog', { name: 'cropEditor.title' });
    loadCropImage(dialog, 800, 400);
    await user.click(within(dialog).getByRole('button', { name: 'cropEditor.confirm' }));

    expect(cropImageInPlace).not.toHaveBeenCalled();
    expect(discardCropResultNode).toHaveBeenCalledWith('crop-3');
    expect(inFlightImageOps.get('img-up')).toBeUndefined();
  });

  it('高清：点「... → 高清」只建结果节点并把详情切过去，不当场提交', () => {
    // 还原 createUpscaleResultNode 的真实副作用（真的在 store 里建出结果节点），
    // 否则详情切过去只会看到「节点已不存在」。
    createUpscaleResultNode.mockImplementation(() => seedUpscaleResultNode());
    openDetail('上传图');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: '高清' }));

    // 只建节点、不提交（对标 liblib：参数在新节点详情里调，按 ↑ 才真正生成）。
    expect(createUpscaleResultNode).toHaveBeenCalledWith('img-up', {
      displayName: '高清放大',
      modelId: 'huimeng/gpt-image-2',
    });
    expect(submitImageUpscale).not.toHaveBeenCalled();
    // 旧的居中参数弹窗已经没有了。
    expect(screen.queryByRole('dialog', { name: '高清放大' })).not.toBeInTheDocument();

    // 详情已切到新建的高清节点，正文下方挂着高清编辑器（模型/画质/倍数 + ↑）。
    const detail = detailPanel();
    expect(within(detail).getByRole('button', { name: 'upscaleEditor.submit' })).toBeInTheDocument();
    // 结果节点已请求视口预定位（Task 10 模式）。
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe(upscaleResultNodeId);
    // 源节点没有进入 busy —— 这一步不产生在途任务。
    expect(inFlightImageOps.get('img-up')).toBeUndefined();

    // 未提交 → 媒体区是空态，不拿待放大的源图充数（否则用户会当成放大后的效果）。
    expect(within(detail).getByText('待确认后生成')).toBeInTheDocument();
    expect(within(detail).queryByRole('img', { name: '高清放大' })).toBeNull();
    // 空态节点整条操作工具条不渲染（下载/「...」/全景… 全要素材才成立）。
    expect(within(detail).queryByRole('button', { name: '更多' })).toBeNull();
    expect(within(detail).queryByRole('button', { name: /全景/ })).toBeNull();
  });

  it('高清：在新节点详情的编辑器里改画质/倍数 → 按 ↑ 提交，参数取自节点 data', async () => {
    const user = userEvent.setup();
    createUpscaleResultNode.mockImplementation(() => seedUpscaleResultNode());
    submitImageUpscale.mockReturnValue(NEVER);
    openDetail('上传图');

    fireEvent.click(within(openMoreMenu()).getByRole('button', { name: '高清' }));

    const detail = detailPanel();
    // 画质在弹出选择器里选（同工作流那张卡片）。
    await user.click(within(detail).getByRole('button', { name: /qualityPicker/ }));
    await user.click(await screen.findByRole('button', { name: '4K' }));
    // 放大倍数是分段按钮组。
    await user.click(within(detail).getByRole('button', { name: '4' }));

    // 改的是节点 data（面板反复挂卸也不会丢），不是组件局部 state。
    const resultData = useCanvasStore
      .getState()
      .nodes.find((n) => n.id === upscaleResultNodeId)?.data as Record<string, unknown>;
    expect(resultData.upscaleImageSize).toBe('4K');
    expect(resultData.upscaleScaleFactor).toBe(4);

    await user.click(within(detail).getByRole('button', { name: 'upscaleEditor.submit' }));

    expect(submitImageUpscale).toHaveBeenCalledWith(upscaleResultNodeId, {
      sourceUrl: '/static/up.png',
      scaleFactor: 4,
      imageSize: '4K',
      model: 'gpt-image-2',
    });
  });

  it('busy 态跨重挂载存活：切走再切回同一节点时仍处于 busy，阻止重复提交/重复计费', async () => {
    const user = userEvent.setup();
    scene360Image.mockReturnValue({ nodeId: 'pano-inflight', completion: NEVER });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { unmount } = render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));
    let detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /全景/ }));

    // 已登记到跨重挂载存活的模块级 Map（不是组件局部 state）。
    expect(inFlightImageOps.get('img-up')).toBe('pano');
    expect(scene360Image).toHaveBeenCalledTimes(1);

    // 模拟详情工具条按 key={node.id} 整体重挂载：卸载再重新渲染（同一节点）。
    unmount();
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '上传图' }));
    detail = detailPanel();

    // 新实例挂载时从模块级登记表里读到了「仍在跑」，触发按钮保持 disabled。
    expect(within(detail).getByRole('button', { name: /全景/ })).toBeDisabled();

    // disabled 状态本身已经挡住了交互入口——编排函数没有被第二次调用，不会重复计费。
    await user.click(within(detail).getByRole('button', { name: /全景/ }));
    expect(scene360Image).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('操作失败兜底反馈：completion settle 时结果节点带 generationError，源节点工具条上出现红色错误文案，8 秒后自动消失', async () => {
    // 贴近真实应用层的 completion 契约：失败不 reject，而是把错误写到结果节点
    // data 上再 resolve（见 imageScene360.ts / imageUpscale.ts 的 catch 分支）。
    scene360Image.mockImplementation(() => {
      const resultNodeId = useCanvasStore.getState().addNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 0, y: 0 },
        { displayName: '全景占位' } as never,
      );
      return {
        nodeId: resultNodeId,
        completion: Promise.resolve().then(() => {
          useCanvasStore.getState().updateNodeData(resultNodeId, {
            generationError: '生成失败：额度不足',
          });
        }),
      };
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    openDetail('上传图');
    const detail = detailPanel();

    vi.useFakeTimers();
    try {
      fireEvent.click(within(detail).getByRole('button', { name: /全景/ }));

      // completion 是 Promise.resolve().then(...) 微任务链，跟假计时器无关
      // （假计时器只拦 setTimeout/setInterval），flush 掉让 trackSpawn 的
      // finally 和 reportOpFailure 跑完，再同步查询（不用 findBy，避免其内部
      // 轮询依赖假计时器）。
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole('alert')).toHaveTextContent('生成失败：额度不足');

      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      confirmSpy.mockRestore();
    }
  });

  it('全景：确认后直接提交（取消确认则不提交）', async () => {
    const user = userEvent.setup();
    scene360Image.mockReturnValue({ nodeId: 'pano-1', completion: NEVER });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    openDetail('上传图');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /全景/ }));
    expect(scene360Image).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(within(detail).getByRole('button', { name: /全景/ }));
    expect(scene360Image).toHaveBeenCalledWith('img-up', '/static/up.png', {
      displayName: '360°全景图',
      aspectRatio: '2:1',
    });
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('pano-1');
    confirmSpy.mockRestore();
  });

  it('多角度：点按钮打开工作流完整弹窗编辑器（portal 到 body），旧内联球面区块不再渲染', async () => {
    const user = userEvent.setup();
    multiAngleImage.mockReturnValue({ nodeId: 'mv-1', completion: NEVER });
    openDetail('上传图');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /多角度/ }));

    // 弹窗 portal 到 document.body：详情面板内找不到，但全局能找到。
    const dialog = await screen.findByRole('dialog', { name: '多维度编辑器' });
    expect(within(detail).queryByRole('dialog')).toBeNull();
    // 旧内联球面选角区块（环绕/俯仰读数）不再共存。
    expect(screen.queryByText(/环绕 0° · 俯仰 0°/)).not.toBeInTheDocument();

    // 提交带上编辑器面板的当前参数（默认水平/垂直 0°、中景），并请求视口预定位。
    await user.click(within(dialog).getByRole('button', { name: 'multiAngleEditor.submit' }));
    expect(multiAngleImage).toHaveBeenCalledWith(
      'img-up',
      '/static/up.png',
      expect.objectContaining({
        preset: 'custom',
        horizontalDeg: 0,
        verticalDeg: 0,
        zoom: 'medium',
        apiModel: 'gpt-image-2',
      }),
    );
    // 提交成功后弹窗自己关闭（onSubmitted → onClose 契约），且视口已预定位到新节点。
    expect(screen.queryByRole('dialog', { name: '多维度编辑器' })).not.toBeInTheDocument();
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('mv-1');
  });

  it('多角度：点弹窗遮罩关闭 —— 面板自身的点外监听与遮罩 onClick 同时命中也只关一次', async () => {
    const user = userEvent.setup();
    openDetail('上传图');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /多角度/ }));
    const dialog = await screen.findByRole('dialog', { name: '多维度编辑器' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 直接点遮罩本身（target === currentTarget），同时触发面板的 document 捕获监听。
    fireEvent.click(dialog);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(screen.queryByRole('dialog', { name: '多维度编辑器' })).not.toBeInTheDocument();
    expect(multiAngleImage).not.toHaveBeenCalled();
    // 没有卡死在半关闭状态：再次点按钮仍能正常重新打开。
    await user.click(within(detail).getByRole('button', { name: /多角度/ }));
    expect(await screen.findByRole('dialog', { name: '多维度编辑器' })).toBeInTheDocument();
  });

  it('重打光：点按钮打开工作流完整弹窗编辑器（portal 到 body），旧内联平面配置行不再渲染', async () => {
    const user = userEvent.setup();
    relightImage.mockReturnValue({ nodeId: 'rl-1', completion: NEVER });
    openDetail('上传图');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /重打光/ }));

    const dialog = await screen.findByRole('dialog', { name: '打光效果编辑器' });
    expect(within(detail).queryByRole('dialog')).toBeNull();
    // 旧内联平面配置行（主光方向分段）不再共存。
    expect(screen.queryByText('主光方向')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'lightEditor.submit' }));
    expect(relightImage).toHaveBeenCalledWith(
      'img-up',
      '/static/up.png',
      expect.objectContaining({
        rimLight: false,
        mainLight: expect.objectContaining({ nearestPreset: 'front' }),
        smartMode: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(screen.queryByRole('dialog', { name: '打光效果编辑器' })).not.toBeInTheDocument();
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('rl-1');
  });

  it('重打光：点弹窗遮罩关闭 —— 只关一次，且不留在半关闭状态', async () => {
    const user = userEvent.setup();
    openDetail('上传图');

    const detail = detailPanel();
    await user.click(within(detail).getByRole('button', { name: /重打光/ }));
    const dialog = await screen.findByRole('dialog', { name: '打光效果编辑器' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(dialog);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(screen.queryByRole('dialog', { name: '打光效果编辑器' })).not.toBeInTheDocument();
    expect(relightImage).not.toHaveBeenCalled();
    await user.click(within(detail).getByRole('button', { name: /重打光/ }));
    expect(await screen.findByRole('dialog', { name: '打光效果编辑器' })).toBeInTheDocument();
  });

});
