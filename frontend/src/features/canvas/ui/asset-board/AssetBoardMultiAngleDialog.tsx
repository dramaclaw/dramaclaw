// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type ReactElement } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { MultiAngleEditorContent } from '@/features/canvas/ui/MultiAngleEditorContent';
import { useCanvasStore } from '@/stores/canvasStore';

import { AssetBoardEditorDialog, useCloseOnce } from './AssetBoardEditorDialog';

export interface AssetBoardMultiAngleDialogProps {
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
 * 故事板详情的「多角度」弹窗：居中弹窗里放**工作流那套完整的多维度编辑器**
 * （球体选角 + 方向钮 + 预设/画质 + 三条滑杆 + 提示词开关 + 算力与提交），
 * 而不是详情内联的简化配置行。
 *
 * 与工作流唯一的差异是提交后的收尾：工作流选中新节点，这里请求视口预定位
 * （故事板可见时画布是 suspended 的，选中态没有意义；预定位让用户切回工作流
 * 时视口已对准结果节点，同 Task 10 模式）。
 */
export function AssetBoardMultiAngleDialog({
  node,
  imageSource,
  onClose,
  onSubmitted,
}: AssetBoardMultiAngleDialogProps): ReactElement {
  // 外壳与内容层必须共用同一个包装后的关闭回调，见 useCloseOnce 的说明。
  const close = useCloseOnce(onClose);
  return (
    <AssetBoardEditorDialog label="多维度编辑器" onClose={close}>
      <MultiAngleEditorContent
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
