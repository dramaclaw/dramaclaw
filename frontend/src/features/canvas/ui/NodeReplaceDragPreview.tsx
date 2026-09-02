// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AudioLines, Box, Film, Replace } from 'lucide-react';

import { useAssetDropStore } from '@/stores/assetDropStore';
import { resolveMediaUrl } from '@/lib/media-url';

/**
 * 「替换素材」拖拽时跟随光标的缩略图浮层。
 *
 * AssetCommitHandle 用原生 pointer 事件自驱动拖拽(非 HTML5 DnD,因此没有浏览器
 * 自带的拖影)。这里订阅 assetDropStore.activeDrag,在拖拽期间用 portal 渲染一张
 * 跟随光标的卡片,与「从素材库拖入画布」时的视觉保持一致,让用户清楚自己正拖着
 * 哪个节点去替换。命中可替换素材时(hoverAssetId)切换为强调态 + 「松开替换」文案。
 */
export function NodeReplaceDragPreview() {
  const { t } = useTranslation();
  const activeDrag = useAssetDropStore((s) => s.activeDrag);
  const hoverAssetId = useAssetDropStore((s) => s.hoverAssetId);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!activeDrag) {
      setPos(null);
      return;
    }
    const onMove = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [activeDrag]);

  if (!activeDrag || !pos) return null;

  const thumb = activeDrag.thumbUrl ? resolveMediaUrl(activeDrag.thumbUrl) : null;
  const overTarget = Boolean(hoverAssetId);

  return createPortal(
    <div
      className="pointer-events-none fixed z-[999] -translate-y-1/2"
      style={{ left: pos.x + 16, top: pos.y }}
    >
      <div
        className={`flex items-center gap-2 rounded-lg border p-1.5 pr-2.5 shadow-[var(--ui-shadow-panel)] backdrop-blur-md transition-colors ${
          overTarget
            ? 'border-accent bg-[rgba(var(--accent-rgb)/0.16)]'
            : 'border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.92)]'
        }`}
      >
        <div className="relative h-10 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--ui-border-soft)]/60 bg-black/30 flex items-center justify-center">
          {thumb ? (
            <img
              src={thumb}
              alt={activeDrag.label}
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : activeDrag.mediaType === 'audio' ? (
            <AudioLines className="h-5 w-5 text-accent" />
          ) : activeDrag.mediaType === 'video' ? (
            <Film className="h-5 w-5 text-text-muted" />
          ) : activeDrag.mediaType === 'model' ? (
            <Box className="h-5 w-5 text-text-muted" />
          ) : (
            <Replace className="h-5 w-5 text-text-muted" />
          )}
        </div>
        <div className="min-w-0 max-w-[160px]">
          <div className="truncate text-xs font-medium text-text" title={activeDrag.label}>
            {activeDrag.label}
          </div>
          <div
            className={`mt-0.5 flex items-center gap-1 text-[11px] leading-snug ${
              overTarget ? 'text-accent' : 'text-text-muted'
            }`}
          >
            <Replace className="h-3 w-3 shrink-0" />
            {overTarget
              ? t('canvas.assetReplace.dropToReplace')
              : t('canvas.assetReplace.dragHint')}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
