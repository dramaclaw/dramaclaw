// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useStore } from '@xyflow/react';

import { deriveNodeDropInfo, useAssetDropStore } from '@/stores/assetDropStore';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

/**
 * 「按住拖到左侧素材库替换同类型素材」这条手势。原本只长在 AssetCommitHandle
 * 那颗浮在节点外侧的按钮上；抽出来是为了让节点内右上角那颗替换按钮
 * (NodeMediaReplaceButton) 也能承接同一手势 —— 同一个角上不该出现两颗长得一样、
 * 各干各的替换按钮。
 *
 * 拖拽全程用原生 pointer 事件自驱动(不是 HTML5 DnD),因此:
 * - 松手命中左侧同类型素材卡片时才提交替换;
 * - 拖拽预览浮层由 NodeReplaceDragPreview 读 store 渲染。
 */
/** 缀在「替换」title 后面的第二行 —— 图标本身说不清「按住拖」这层语义。 */
export const ASSET_COMMIT_DRAG_HINT = '按住拖到左侧素材库,替换同类型素材';

export function useAssetCommitDrag(node: CanvasNode | null | undefined) {
  const dropInfo = node ? deriveNodeDropInfo(node) : null;
  const sourceUrl = dropInfo?.sourceUrl ?? null;
  const nodeId = node?.id ?? null;

  const startDrag = useCallback(() => {
    if (!nodeId || !dropInfo || !sourceUrl) return;

    useAssetDropStore.getState().beginDrag({
      nodeId,
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
  }, [dropInfo, nodeId, sourceUrl]);

  return { canCommit: Boolean(dropInfo && sourceUrl), startDrag };
}

/**
 * 节点组件内部只拿得到 id/data,拿不到完整 CanvasNode(还要节点 type 才能判断
 * 媒体类型),这里直接从 React Flow 的 nodeLookup 取当前节点。
 */
export function useAssetCommitDragById(nodeId: string) {
  const node = useStore(
    useCallback(
      (state) => (state.nodeLookup.get(nodeId) ?? null) as CanvasNode | null,
      [nodeId],
    ),
  );
  return useAssetCommitDrag(node);
}
