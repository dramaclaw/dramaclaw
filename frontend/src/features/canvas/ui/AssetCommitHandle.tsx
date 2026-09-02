// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Replace } from 'lucide-react';
import { Position } from '@xyflow/react';

import {
  deriveNodeDropInfo,
  useAssetDropStore,
} from '@/stores/assetDropStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';

/**
 * 节点左侧的「拖到素材库替换」抓手。从抓手上按住拖拽时,
 * 节点本身不会在画布上移动 —— 我们用原生 pointer 事件自行驱动,
 * 并在松手命中左侧同类型素材时触发替换。
 */
export function AssetCommitHandle({ node }: { node: CanvasNode }) {
  const { t } = useTranslation();
  const dropInfo = deriveNodeDropInfo(node);
  const sourceUrl = dropInfo?.sourceUrl ?? null;

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!dropInfo || !sourceUrl || event.button !== 0) return;
      // 阻止 React Flow 接管 → 节点不会被拖动。
      event.preventDefault();
      event.stopPropagation();

      useAssetDropStore.getState().beginDrag({
        nodeId: node.id,
        mediaType: dropInfo.mediaType,
        sourceUrl,
        thumbUrl: dropInfo.thumbUrl,
        label: dropInfo.label,
        directorControlBundle: dropInfo.directorControlBundle,
      });

      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';

      const onMove = (e: PointerEvent) => {
        const drag = useAssetDropStore.getState().activeDrag;
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        let hoverId: string | null = null;
        for (const el of elements) {
          const card = (el as Element).closest?.(
            '[data-asset-id]',
          ) as HTMLElement | null;
          if (!card) continue;
          const assetType = card.dataset.assetMediaType;
          if (drag && assetType && assetType === drag.mediaType) {
            hoverId = card.dataset.assetId ?? null;
          }
          break;
        }
        useAssetDropStore.getState().setHoverAsset(hoverId);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        // 命中有效素材则生成替换请求,由侧栏消费。
        useAssetDropStore.getState().endDrag(true);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [dropInfo, node.id, sourceUrl],
  );

  if (!dropInfo || !sourceUrl) return null;

  return (
    <NodeSideActionRail nodeId={node.id} position={Position.Left}>
      <button
        type="button"
        onPointerDown={handlePointerDown}
        title={t('canvas.assetReplace.handleHint')}
        className={`${NODE_SIDE_ACTION_BUTTON_CLASS} active:cursor-grabbing`}
        style={{ cursor: 'grab' }}
      >
        <Replace className={NODE_SIDE_ACTION_ICON_CLASS} />
        {t('canvas.assetReplace.handleLabel')}
      </button>
    </NodeSideActionRail>
  );
}
