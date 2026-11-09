// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, type ImgHTMLAttributes, type MouseEvent } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { openNodeImageViewer } from '../application/nodeMediaViewer';

export interface CanvasNodeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  viewerSourceUrl?: string | null;
  viewerNodeId?: string;
  viewerImageList?: Array<string | null | undefined>;
  disableViewer?: boolean;
}

export const CanvasNodeImage = memo(({
  viewerSourceUrl,
  viewerNodeId,
  viewerImageList,
  disableViewer = false,
  onDoubleClick,
  src,
  ...props
}: CanvasNodeImageProps) => {
  const openImageViewer = useCanvasStore((state) => state.openImageViewer);
  const displaySrc = src;

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    onDoubleClick?.(event);

    if (event.defaultPrevented || disableViewer) {
      return;
    }

    const fallbackSrc = event.currentTarget.currentSrc || (typeof displaySrc === 'string' ? displaySrc : '');
    const resolvedSource =
      typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
        ? viewerSourceUrl.trim()
        : fallbackSrc.trim();
    if (!resolvedSource) {
      return;
    }

    event.stopPropagation();
    const images = viewerImageList ?? [];
    if (viewerNodeId) void openNodeImageViewer(resolvedSource, viewerNodeId, images);
    else openImageViewer(resolvedSource, images);
  }, [disableViewer, displaySrc, onDoubleClick, openImageViewer, viewerImageList, viewerSourceUrl, viewerNodeId]);

  return (
    <img
      draggable={false}
      {...props}
      src={displaySrc}
      data-viewer-src={
        typeof viewerSourceUrl === 'string' && viewerSourceUrl.trim().length > 0
          ? viewerSourceUrl.trim()
          : undefined
      }
      onDoubleClick={handleDoubleClick}
    />
  );
});

CanvasNodeImage.displayName = 'CanvasNodeImage';
