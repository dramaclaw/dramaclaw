// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Boxes, Crop, Globe2, ImageUpscale, Lightbulb, RotateCw } from 'lucide-react';

import {
  createCropResultNode,
  discardCropResultNode,
} from '@/features/canvas/application/imageCrop';
import {
  createRotateResultNode,
  discardRotateResultNode,
} from '@/features/canvas/application/imageRotate';
import { scene360Image } from '@/features/canvas/application/imageScene360';
import { createUpscaleResultNode } from '@/features/canvas/application/imageUpscale';
import { nodeMainlineFlags } from '@/features/canvas/domain/mainlineNodeFlags';
import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import {
  DEFAULT_SHARED_MODEL_ID,
  SHARED_MODELS,
} from '@/features/canvas/ui/ProviderModelPicker';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardCropDialog } from './AssetBoardCropDialog';
import { AssetBoardMultiAngleDialog } from './AssetBoardMultiAngleDialog';
import { AssetBoardRelightDialog } from './AssetBoardRelightDialog';
import { AssetBoardRotateDialog } from './AssetBoardRotateDialog';
import { createAssetBoardOpsRegistry } from './assetBoardOpsState';
import { DetailToolbarButton } from './AssetBoardToolbarButton';
// 仅类型（编译期擦除），不构成与 AssetBoardDetailToolbar 的运行时循环 import。
import type { MoreMenuEntry } from './AssetBoardDetailToolbar';

/**
 * 进行中的生成类操作（触发按钮转 spinner，settle 后恢复）。
 *
 * 高清不在此列：它改成先建节点再在那个节点的详情里按 ↑ 提交，进行中反馈落在结果
 * 节点自己身上（isGenerating → 详情媒体区的「生成中 X%」），源节点这边无事可等。
 */
type BusyOp = 'crop' | 'rotate' | 'pano' | null;

/**
 * 跨重挂载存活的「进行中操作 + 失败反馈」登记表。实现与设计理由已上提到
 * assetBoardOpsState.ts（视频详情工具条复用同一套），这里只建图片侧的实例。
 */
const imageOpsRegistry = createAssetBoardOpsRegistry<Exclude<BusyOp, null>>();
const { markOpStart, markOpSettled, reportOpFailure } = imageOpsRegistry;
const useInFlightOp = (nodeId: string): BusyOp => imageOpsRegistry.useInFlightOp(nodeId);
const useOpFailure = (nodeId: string): string | null =>
  imageOpsRegistry.useOpFailure(nodeId);

/**
 * 导出供测试断言（跨重挂载存活的 busy 态登记表：nodeId → 进行中的操作名）；
 * 生产代码只应通过组件内部的 markOpStart / markOpSettled 改它，不要直接操作。
 */
export const inFlightImageOps: ReadonlyMap<string, Exclude<BusyOp, null>> =
  imageOpsRegistry.inFlight;

/**
 * 仅供测试使用：清空两张模块级登记表（进行中操作 + 失败文案），避免用例间
 * 靠固定 node id（如测试用的 'img-up'）串态——生产代码永远不需要调用这个。
 */
export function __resetAssetBoardImageOpsStateForTest(): void {
  imageOpsRegistry.resetForTest();
}

/**
 * 生成类操作的统一收尾：结果节点已同步建好 → 立即请求视口预定位（切回工作流
 * 时视口已就位，见 Task 10），并把源节点的触发入口置 busy 直到后台链 settle。
 *
 * 模块级函数而不是组件内 useCallback：编辑三项（高清/裁剪/旋转）已拆到
 * {@link useAssetBoardImageEditActions}，与仍在 {@link AssetBoardImageOps} 里的
 * 全景共用同一份收尾逻辑，两边都只依赖 nodeId。
 */
function trackSpawn(
  sourceNodeId: string,
  op: Exclude<BusyOp, null>,
  resultNodeId: string,
  completion: Promise<void>,
): void {
  useCanvasStore.getState().requestFocusNode(resultNodeId);
  markOpStart(sourceNodeId, op);
  void completion.finally(() => {
    markOpSettled(sourceNodeId);
    // 失败只写到了新建的结果节点上（generationError），源节点这边补一行
    // 红色提示——否则用户停在源节点详情面板，完全看不到刚才那次操作失败了。
    const resultNode = useCanvasStore.getState().nodes.find((n) => n.id === resultNodeId);
    const errorMessage = (resultNode?.data as { generationError?: unknown } | undefined)
      ?.generationError;
    if (typeof errorMessage === 'string' && errorMessage) {
      reportOpFailure(sourceNodeId, errorMessage);
    }
  });
}

/**
 * 图片「编辑」三项——**高清 / 裁剪 / 旋转**——的菜单条目与它们的编辑器弹窗。
 *
 * 为什么是 hook 而不是组件：用户要求删掉工具条上那颗「编辑」下拉，把这三项搬进最
 * 右边的「...」菜单；而「...」由 AssetBoardImageDetailToolbar 渲染、且必须排在「宫格
 * 模板」之后。菜单条目只能交给调用方拼装，弹窗与 cropNodeId/rotateNodeId 这类状态则
 * 连同 `overlays` 一起吐回去挂载。
 *
 * - 高清「先建节点、不提交」（对标 liblib）：在下游建一个空的高清结果节点并把详情
 *   切过去，参数在新节点详情下方的高清编辑器里调、按 ↑ 才提交（AssetBoardUpscaleForm）。
 * - 裁剪 / 旋转都走大图实时预览编辑器：先预建结果节点，编辑器在它身上本地变换后
 *   写回，取消则回收。编排都走 application/image*（与工作流 overlay 同源，语义一致）。
 *
 * 不含工作流那边的重绘 / 擦除（要在图上刷蒙版，故事板详情不做）与扩图（位置让给
 * 裁剪），都属于用户拍过板的取舍。
 */
export function useAssetBoardImageEditActions({
  node,
  imageSource,
  onOpenNode,
}: {
  node: CanvasNode;
  /** 已由调用方解析的图源；为空表示这个节点还没图可编辑，返回空条目。 */
  imageSource: string | null;
  /**
   * 建出新节点后把详情切过去（同宫格模板 / 头部「创建副本」那条路径）。高清就是
   * 靠它把用户带到新建的高清节点详情里去调参数——不切详情用户看不出发生了什么。
   */
  onOpenNode?: (nodeId: string) => void;
}): { entries: MoreMenuEntry[]; overlays: ReactElement | null } {
  const busyOp = useInFlightOp(node.id);
  // 裁剪 / 旋转：进入编辑器前就把结果节点建好（同工作流 SelectedNodeOverlay），
  // 编辑器实时预览、保存时把结果写回这个节点；取消则回收它。
  const [cropNodeId, setCropNodeId] = useState<string | null>(null);
  const [rotateNodeId, setRotateNodeId] = useState<string | null>(null);

  const { models: imageModels } = useFreezoneImageModels();
  // 模型选择优先级同工作流 UpscaleEditorOverlay / OutpaintEditorOverlay：优先取
  // 默认共享模型（DEFAULT_SHARED_MODEL_ID），可用列表里没有再退到首个可用模型，
  // 都拿不到才退到硬编码 SHARED_MODELS 兜底。
  const selectedModelId =
    (imageModels.find((model) => model.id === DEFAULT_SHARED_MODEL_ID)
      ?? imageModels[0]
      ?? SHARED_MODELS.find((model) => model.id === DEFAULT_SHARED_MODEL_ID))?.id
    ?? DEFAULT_SHARED_MODEL_ID;

  // 与工作流 NodeActionToolbar 同源的显隐语义：preset_managed（主线投影锁定）节点
  // 隐藏「原地改写源图」的入口——高清与旋转都是 updateNodeData 回写，会破坏
  // canonical 不可变性；裁剪 spawn 出的是 user_spawned 子节点，锁定态下照常可用。
  const isPresetLocked = useMemo(() => nodeMainlineFlags(node).isPresetManaged, [node]);

  /**
   * 高清 = **先建节点、不提交**（对标 liblib，与宫格模板同一条路径）：在源图下游建
   * 一个空的高清结果节点，详情随即切过去，用户在新节点详情下方的高清编辑器里选
   * 模型/画质/倍数、按 ↑ 才真正提交（AssetBoardUpscaleForm）。
   *
   * 这里不再当场 submit，所以也不挂源节点的 busy 态——在途反馈落在结果节点自己
   * 身上（isGenerating → 详情媒体区的「生成中 X%」）。
   */
  const handleOpenHd = useCallback(() => {
    if (busyOp) return;
    const resultNodeId = createUpscaleResultNode(node.id, {
      displayName: '高清放大',
      modelId: selectedModelId,
    });
    if (!resultNodeId) return;
    // 低成本视口预定位（M7）：结果节点已同步建好，保活挂载的 Canvas 先把视口对准
    // 它，用户切回工作流时不用自己找。
    useCanvasStore.getState().requestFocusNode(resultNodeId);
    onOpenNode?.(resultNodeId);
  }, [busyOp, node.id, onOpenNode, selectedModelId]);

  /**
   * 打开裁剪编辑器：与旋转同一条路——先把「裁剪结果」节点建出来（源图保持不动），
   * 编辑器直接在这个节点上写回结果。用户取消时由 handleCloseCrop 回收。
   */
  const handleOpenCrop = useCallback(() => {
    if (busyOp) return;
    const resultNodeId = createCropResultNode(node.id, { displayName: '裁剪结果' });
    if (!resultNodeId) return;
    setCropNodeId(resultNodeId);
  }, [busyOp, node.id]);

  const handleCloseCrop = useCallback(
    (committed: boolean) => {
      // 未提交（退出 / Esc / 取景框就是整张图）→ 回收预建的结果节点。
      if (!committed && cropNodeId) discardCropResultNode(cropNodeId);
      setCropNodeId(null);
    },
    [cropNodeId],
  );

  const handleCropCommitted = useCallback(
    (completion: Promise<void>) => {
      if (cropNodeId) trackSpawn(node.id, 'crop', cropNodeId, completion);
    },
    [cropNodeId, node.id],
  );

  /**
   * 打开旋转编辑器：与工作流一致，先把「旋转结果」节点建出来（源图保持不动），
   * 编辑器直接在这个节点上写回结果。用户取消时由 handleCloseRotate 回收。
   */
  const handleOpenRotate = useCallback(() => {
    if (busyOp) return;
    const resultNodeId = createRotateResultNode(node.id, { displayName: '旋转结果' });
    if (!resultNodeId) return;
    setRotateNodeId(resultNodeId);
  }, [busyOp, node.id]);

  const handleCloseRotate = useCallback(
    (committed: boolean) => {
      // 未提交（退出 / Esc / 没做任何变换）→ 回收预建的结果节点，避免凭空多出一个空节点。
      if (!committed && rotateNodeId) discardRotateResultNode(rotateNodeId);
      setRotateNodeId(null);
    },
    [rotateNodeId],
  );

  const handleRotateCommitted = useCallback(
    (completion: Promise<void>) => {
      if (rotateNodeId) trackSpawn(node.id, 'rotate', rotateNodeId, completion);
    },
    [node.id, rotateNodeId],
  );

  const entries: MoreMenuEntry[] = !imageSource
    ? []
    : (
        [
          { kind: 'action', key: 'hd', icon: ImageUpscale, label: '高清', onSelect: handleOpenHd },
          { kind: 'action', key: 'crop', icon: Crop, label: '裁剪', busy: busyOp === 'crop', onSelect: handleOpenCrop },
          { kind: 'action', key: 'rotate', icon: RotateCw, label: '旋转', busy: busyOp === 'rotate', onSelect: handleOpenRotate },
        ] satisfies MoreMenuEntry[]
      ).filter((entry) => !(isPresetLocked && (entry.key === 'hd' || entry.key === 'rotate')));

  const overlays =
    !imageSource || (!cropNodeId && !rotateNodeId) ? null : (
      <>
        {/* 裁剪：大图 + 取景框 + 悬浮控制条（liblib 同款）。纯本地 canvas 切图，
            不走生成接口。 */}
        {cropNodeId && (
          <AssetBoardCropDialog
            nodeId={cropNodeId}
            imageSource={imageSource}
            onClose={handleCloseCrop}
            onCommitted={handleCropCommitted}
          />
        )}
        {/* 旋转：大图实时预览 + 悬浮控制条（libtv 同款），与工作流 RotateEditorOverlay
            共用同一套内容层，只是外壳换成 portal 弹窗。 */}
        {rotateNodeId && (
          <AssetBoardRotateDialog
            nodeId={rotateNodeId}
            imageSource={imageSource}
            onClose={handleCloseRotate}
            onCommitted={handleRotateCommitted}
          />
        )}
      </>
    );

  return { entries, overlays };
}

interface AssetBoardImageOpsProps {
  node: CanvasNode;
  /** 已由调用方用 resolveNodeSourceImageUrl 解析的图源（无图源时调用方不渲染本组件）。 */
  imageSource: string;
}

/**
 * 故事板详情的图片生成操作区：**全景 / 多角度 / 重打光** 三颗常显按钮。
 *
 * 编辑三项（高清/裁剪/旋转）不在这里——它们已搬进工具条最右那颗「...」菜单，由
 * {@link useAssetBoardImageEditActions} 提供条目与弹窗（用户要求删掉「编辑」下拉）。
 *
 * - 多角度 / 重打光打开工作流那套完整弹窗编辑器（AssetBoardMultiAngleDialog /
 *   AssetBoardRelightDialog，同样 portal 到 document.body），球体选角/光球方向、
 *   滑杆、画质、提示词开关、算力与提交都在弹窗内容层自理。
 * - 全景无必选参数，直接确认后提交。
 *
 * 返回的是 fragment：按钮直接落在调用方的 flex-wrap 工具条里，参数弹窗都 portal
 * 到 body，不再占工具条的版面。失败兜底文案（含裁剪/旋转的失败）也挂在这里——
 * 三处操作共用同一张按 nodeId 记的登记表。
 */
export function AssetBoardImageOps({
  node,
  imageSource,
}: AssetBoardImageOpsProps): ReactElement {
  // busy 态跨重挂载存活（详情工具条按 key={node.id} 整体重挂载），不是组件局部
  // state——见 inFlightImageOps 的说明。
  const busyOp = useInFlightOp(node.id);
  const opFailure = useOpFailure(node.id);
  // 多角度 / 重打光：不再是内联配置行，改成打开工作流那套完整弹窗编辑器
  // （AssetBoardMultiAngleDialog / AssetBoardRelightDialog）；busy/算力/提交都在
  // 弹窗内容层自理，这里只管开关。
  const [multiAngleOpen, setMultiAngleOpen] = useState(false);
  const [relightOpen, setRelightOpen] = useState(false);

  const handlePanoSubmit = useCallback(() => {
    if (busyOp) return;
    if (!window.confirm('确认基于本图生成 360° 全景图？')) return;
    const result = scene360Image(node.id, imageSource, {
      displayName: '360°全景图',
      aspectRatio: '2:1',
    });
    if (!result) return;
    trackSpawn(node.id, 'pano', result.nodeId, result.completion);
  }, [busyOp, imageSource, node.id]);

  return (
    <>
      <DetailToolbarButton
        icon={Globe2}
        label="全景"
        busy={busyOp === 'pano'}
        disabled={busyOp !== null}
        title="基于本图生成 360° 全景图（并挂一个全景查看器节点）"
        onClick={handlePanoSubmit}
      />
      <DetailToolbarButton
        icon={Boxes}
        label="多角度"
        disabled={busyOp !== null}
        title="打开多维度编辑器（球体选角 + 画质 + 提示词）"
        onClick={() => setMultiAngleOpen(true)}
      />
      <DetailToolbarButton
        icon={Lightbulb}
        label="重打光"
        disabled={busyOp !== null}
        title="打开打光效果编辑器（方向 + 亮度/色温 + 智能模式）"
        onClick={() => setRelightOpen(true)}
      />

      {/* 操作失败兜底反馈：失败信息只写在新建结果节点上，用户还停在源节点详情
          面板看不到；这里补一行红色文案，settle 后自动消失（见 reportOpFailure
          的说明）。 */}
      {opFailure && (
        <div
          role="alert"
          className="w-full rounded-[6px] border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-300"
        >
          {opFailure}
        </div>
      )}

      {/* 多角度 / 重打光：工作流那套完整弹窗编辑器（球体选角/光球方向 + 滑杆 +
          画质 + 提示词开关 + 算力 + 提交），居中弹窗 portal 到 document.body。
          提交成功后弹窗自己请求视口预定位并关闭（见 AssetBoardMultiAngleDialog /
          AssetBoardRelightDialog 的 onSubmitted 组合），这里只管开关状态。 */}
      {multiAngleOpen && (
        <AssetBoardMultiAngleDialog
          node={node}
          imageSource={imageSource}
          onClose={() => setMultiAngleOpen(false)}
        />
      )}
      {relightOpen && (
        <AssetBoardRelightDialog
          node={node}
          imageSource={imageSource}
          onClose={() => setRelightOpen(false)}
        />
      )}
    </>
  );
}
