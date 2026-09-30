// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { LightEditorContent } from '@/features/canvas/ui/LightEditorContent';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardEditorDialog, useCloseOnce } from './AssetBoardEditorDialog';

export interface AssetBoardRelightDialogProps {
  /** 源图片节点。 */
  node: CanvasNode;
  /** 已解析的图源。 */
  imageSource: string;
  /** 关闭弹窗（提交成功后内容层也会调用）。 */
  onClose: () => void;
  /** 提交成功回调，入参新结果节点 id（默认已请求视口预定位，这里可再叠 busy 态收尾）。 */
  onSubmitted?: (nodeId: string) => void;
}

/**
 * 故事板详情的「重打光」弹窗：居中弹窗里放**工作流那套完整的打光编辑器**
 * （光球方向拖拽 + 亮度/色温 + 轮廓光 + 智能模式与预设 + 算力与提交），
 * 而不是详情内联的简化配置行。
 *
 * 提交后的收尾同多角度弹窗：请求视口预定位而非选中（见
 * AssetBoardMultiAngleDialog 的说明）。
 */
export function AssetBoardRelightDialog({
  node,
  imageSource,
  onClose,
  onSubmitted,
}: AssetBoardRelightDialogProps): ReactElement {
  // 外壳与内容层必须共用同一个包装后的关闭回调，见 useCloseOnce 的说明。
  const close = useCloseOnce(onClose);
  return (
    <AssetBoardEditorDialog label="打光效果编辑器" onClose={close}>
      <LightEditorContent
        node={node}
        imageSource={imageSource}
        onClose={close}
        onSubmitted={(nodeId) => {
          useCanvasStore.getState().requestFocusNode(nodeId);
          onSubmitted?.(nodeId);
        }}
      />
    </AssetBoardEditorDialog>
  );
}
