// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { NodeToolbar, Position } from '@xyflow/react';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { ImageResizePanel } from './ImageResizeDialog';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

/** Follows the source node below its bottom edge, with no modal/backdrop. */
export function ImageResizeOverlay({ node, imageSource, onClose, onCreated }: {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
  onCreated: (nodeId: string) => void;
}) {
  return <NodeToolbar nodeId={node.id} isVisible position={Position.Bottom}
    align="center" offset={12} className={NODE_TOOLBAR_CLASS}>
    <ZoomScaledToolbar origin="top center">
      <ImageResizePanel nodeId={node.id} imageSource={imageSource}
        onClose={onClose} onCreated={onCreated} />
    </ZoomScaledToolbar>
  </NodeToolbar>;
}
