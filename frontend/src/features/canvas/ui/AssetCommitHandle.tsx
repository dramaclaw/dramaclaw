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

/** 按下后位移不超过这个像素数,判定为「点击」而不是「拖拽」。 */
const CLICK_SLOP_PX = 4;

/**
 * 节点左侧的「替换素材」入口。两种用法:
 *
 * - **拖**:从抓手上按住拖到左侧素材库的同类型素材上松手,直接替换。节点本身
 *   不会在画布上移动 —— 我们用原生 pointer 事件自行驱动。
 * - **点**:它长得就是个按钮,而且素材库默认是收起的(拖出去没有任何落点),
 *   所以单击不能是空操作。点一下进入「挑选态」,由宿主展开素材库,再点一条
 *   同类型素材完成替换。
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

      const start = { x: event.clientX, y: event.clientY };
      let moved = false;

      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'grabbing';

      const onMove = (e: PointerEvent) => {
        if (!moved
          && (Math.abs(e.clientX - start.x) > CLICK_SLOP_PX
            || Math.abs(e.clientY - start.y) > CLICK_SLOP_PX)) {
          moved = true;
        }
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
        const store = useAssetDropStore.getState();
        const hitAsset = Boolean(store.hoverAssetId);
        // 没移动过、也没命中素材 —— 这是一次点击,不是失败的拖拽。转入挑选态,
        // 否则用户看到的就是「点了个按钮什么都没发生」。
        if (!moved && !hitAsset) {
          store.endDrag(false);
          store.beginPick({
            nodeId: node.id,
            mediaType: dropInfo.mediaType,
            sourceUrl,
            thumbUrl: dropInfo.thumbUrl,
            label: dropInfo.label,
            directorControlBundle: dropInfo.directorControlBundle,
          });
          return;
        }
        // 命中有效素材则生成替换请求,由侧栏消费。
        store.endDrag(true);
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
