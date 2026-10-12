// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import type {
  LightMainLightDescriptor,
  LightSmartModeDescriptor,
} from '@/features/canvas/ui/LightEditorPanel';
import { LightEditorContent } from '@/features/canvas/ui/LightEditorContent';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

export interface LightEditorRequestPayload {
  sourceNodeId: string;
  imageSource: string;
  brightness: number;
  color: string;
  mainLight: LightMainLightDescriptor;
  rimLight: boolean;
  smartMode: LightSmartModeDescriptor;
  prompt: string;
  displayName: string;
  generationMode: 'image_reference';
  requestAspectRatio: 'auto';
  submittedAt: string;
}

interface LightEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

/**
 * 打光编辑器的**工作流外壳**：把内容层（LightEditorContent）挂到画布节点下方并
 * 跟随画布缩放。编辑器本体与提交编排都在内容层，这里只剩定位 +
 * 「提交后选中新结果节点」——与拆分前等价（onSubmitted=setSelectedNode，
 * 内容层在其后调 onClose，顺序同旧 handleSubmit）。
 */
export const LightEditorOverlay = memo(
  ({ node, imageSource, onClose }: LightEditorOverlayProps) => {
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);

    return (
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="start"
        offset={16}
        className={NODE_TOOLBAR_CLASS}
      >
        {/* 操作区跟随画布缩放（align=start → 锚点左上角，贴节点底边）。 */}
        <ZoomScaledToolbar origin="top left">
          <LightEditorContent
            node={node}
            imageSource={imageSource}
            onClose={onClose}
            onSubmitted={setSelectedNode}
          />
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  }
);

LightEditorOverlay.displayName = 'LightEditorOverlay';
