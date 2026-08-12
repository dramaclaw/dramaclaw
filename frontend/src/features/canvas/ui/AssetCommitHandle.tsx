// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { Position } from '@xyflow/react';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  NODE_SIDE_ACTION_ICON_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';
import { useAssetCommitDrag } from '@/features/canvas/ui/useAssetCommitDrag';

/**
 * 节点右上角的「拖到素材库替换」抓手。从抓手上按住拖拽时,
 * 节点本身不会在画布上移动 —— 手势由 useAssetCommitDrag 用原生 pointer 事件驱动。
 *
 * 只给图标不给文案:这颗按钮只在选中态出现、又贴着节点角,一块「替换素材」文字
 * 胶囊在缩放态下会盖住节点内容;语义靠 title 兜。图标与节点内那颗替换按钮
 * (NodeMediaReplaceButton) 统一成上传图标 —— 用户眼里它们是同一件事。
 *
 * 卡片内已经有那颗替换按钮的节点(allowLocalReplace)不挂这条抓手,拖拽手势由
 * 卡片内那颗一并承接,见 SelectedNodeOverlay。
 */
export function AssetCommitHandle({ node }: { node: CanvasNode }) {
  const { t } = useTranslation();
  const { canCommit, startDrag } = useAssetCommitDrag(node);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      // 阻止 React Flow 接管 → 节点不会被拖动。
      event.preventDefault();
      event.stopPropagation();
      startDrag();
    },
    [startDrag],
  );

  if (!canCommit) return null;

  return (
    <NodeSideActionRail nodeId={node.id} position={Position.Right} anchorAtCorner>
      <button
        type="button"
        onPointerDown={handlePointerDown}
        aria-label={t('canvas.assetReplace.handleLabel')}
        title={t('canvas.assetReplace.handleHint')}
        className={`${NODE_SIDE_ACTION_ICON_BUTTON_CLASS} active:cursor-grabbing`}
        style={{ cursor: 'grab' }}
      >
        <Upload className={NODE_SIDE_ACTION_ICON_CLASS} />
      </button>
    </NodeSideActionRail>
  );
}
