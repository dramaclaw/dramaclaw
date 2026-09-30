// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';

import {
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { RotateEditorToolbar, useRotateEditor } from './rotateEditorContent';

interface RotateEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  /**
   * 关闭旋转编辑器。`committed` 表示是否真正提交了一次旋转（开始写回节点）：
   *   - `false`：用户退出 / 按 Esc / 无任何变换直接关闭 —— 调用方应把进入旋转时
   *     预创建的「旋转结果」节点删掉，避免凭空多出一个节点。
   *   - `true` ：已开始把旋转结果写回该节点，调用方保留它。
   */
  onClose: (committed: boolean) => void;
}

/**
 * 工作流画布上的旋转编辑器外壳：预览与控制条都挂在节点上方的 NodeToolbar 上，
 * 随节点一起被视口变换。状态机与控制条本体在 `rotateEditorContent`，与故事板
 * 详情页的 `AssetBoardRotateDialog` 共用。
 */
export const RotateEditorOverlay = memo(
  ({ node, imageSource, onClose }: RotateEditorOverlayProps) => {
    const controller = useRotateEditor({ nodeId: node.id, imageSource, onClose });

    const nodeWidth =
      typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.width === 'number'
          ? node.width
          : DEFAULT_NODE_WIDTH;
    const nodeHeight =
      typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.height === 'number'
          ? node.height
          : nodeWidth;

    return (
      <>
        {/* 不透明遮罩 + 实时变换的预览图，盖住原节点图。 */}
        <ReactFlowNodeToolbar
          nodeId={node.id}
          isVisible
          position={Position.Top}
          align="center"
          offset={0}
          className={`${NODE_TOOLBAR_CLASS} pointer-events-none`}
        >
          <div className="relative" style={{ width: 0, height: 0 }}>
            <div
              className="pointer-events-none absolute overflow-hidden rounded-md bg-bg-dark"
              style={{
                width: nodeWidth,
                height: nodeHeight,
                left: '50%',
                top: nodeHeight / 2,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <img
                src={imageSource}
                alt=""
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  transform: controller.transform,
                  transition: 'transform 120ms ease-out',
                }}
              />
            </div>
          </div>
        </ReactFlowNodeToolbar>

        {/* 控制条：浮动在节点上方。 */}
        <ReactFlowNodeToolbar
          nodeId={node.id}
          isVisible
          position={Position.Top}
          align="center"
          offset={25}
          className={NODE_TOOLBAR_CLASS}
        >
          {/* 不显示标题：这条控制条宽度贴着节点走，加标题会顶出节点边界。 */}
          <RotateEditorToolbar controller={controller} />
        </ReactFlowNodeToolbar>
      </>
    );
  },
);

RotateEditorOverlay.displayName = 'RotateEditorOverlay';
