// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback } from 'react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  MultiAngleEditorPanel,
  type MultiAngleSubmitPayload,
} from '@/features/canvas/ui/MultiAngleEditorPanel';
import { multiAngleImage } from '@/features/canvas/application/imageMultiAngle';

export interface MultiAngleEditorContentProps {
  /** 源图片节点（结果节点建在它下游）。 */
  node: CanvasNode;
  /** 已解析的图源（调用方用 resolveNodeSourceImageUrl 取）。 */
  imageSource: string;
  /** 关闭编辑器。提交成功后也会被调用（在 onSubmitted 之后）。 */
  onClose: () => void;
  /**
   * 提交成功、结果节点已同步建好时回调，入参是新结果节点 id。
   * 宿主决定后续动作——工作流侧选中该节点，故事板侧请求视口预定位。
   * 缺 project / 源节点不存在导致没提交成功时不会触发（也不会 onClose）。
   */
  onSubmitted?: (nodeId: string) => void;
}

/**
 * 多维度编辑器的**纯内容层**：完整的编辑器面板 + 提交编排，不含任何 React Flow
 * 依赖（无 NodeToolbar / useReactFlow / ZoomScaledToolbar），因此既能挂在画布节点
 * 下方（MultiAngleEditorOverlay），也能塞进故事板的居中弹窗
 * （AssetBoardMultiAngleDialog）。
 *
 * 提交走 application/imageMultiAngle（与工作流同源），本组件不碰选中态/视口，
 * 一律通过 onSubmitted 交给宿主，避免两种宿主的行为互相污染。
 */
export const MultiAngleEditorContent = memo(
  ({ node, imageSource, onClose, onSubmitted }: MultiAngleEditorContentProps) => {
    const handleSubmit = useCallback(
      (payload: MultiAngleSubmitPayload) => {
        const result = multiAngleImage(node.id, imageSource, payload);
        if (!result) return;
        onSubmitted?.(result.nodeId);
        onClose();
      },
      [imageSource, node.id, onClose, onSubmitted],
    );

    return (
      <MultiAngleEditorPanel
        imageSource={imageSource}
        onClose={onClose}
        onSubmit={handleSubmit}
      />
    );
  },
);

MultiAngleEditorContent.displayName = 'MultiAngleEditorContent';
