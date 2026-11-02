// SPDX-License-Identifier: Elastic-2.0
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export interface MediaHoverPreviewSource {
  imageUrl?: string | null;
  videoUrl?: string | null;
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
  placement?: 'above' | 'side';
}

export function mediaHoverPreviewPlacement(source: MediaHoverPreviewSource, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight) {
  const width = Math.min(176, viewportWidth - 16), height = Math.min(132, viewportHeight - 16);
  const clampX = (x: number) => Math.max(8, Math.min(x, viewportWidth - width - 8));
  const clampY = (y: number) => Math.max(8, Math.min(y, viewportHeight - height - 8));
  const right = source.rect.right + 8;
  return {
    width, height,
    left: source.placement === 'side' ? clampX(right + width <= viewportWidth - 8 ? right : source.rect.left - width - 8) : clampX(source.rect.left),
    top: clampY(source.placement === 'side' ? source.rect.top : source.rect.top - height - 8),
  };
}

/** Shared passive image/video preview for mention chips and candidate rows. */
export function MediaHoverPreview({ source }: { source: MediaHoverPreviewSource | null }) {
  const { t } = useTranslation();
  if (!source || (!source.imageUrl && !source.videoUrl)) return null;
  return createPortal(<div role="img" aria-label={t('canvas.reference.preview')}
    className="canvas-node-transient-ui pointer-events-none fixed z-[10001] overflow-hidden rounded-[var(--ui-radius-lg)] border border-white/15 bg-surface-dark/95 shadow-xl"
    style={mediaHoverPreviewPlacement(source)}>
    {source.imageUrl
      ? <img src={source.imageUrl} alt="" className="h-full w-full object-contain" draggable={false} />
      : <video src={source.videoUrl ?? undefined} autoPlay loop muted playsInline className="h-full w-full object-contain" />}
  </div>, document.body);
}
