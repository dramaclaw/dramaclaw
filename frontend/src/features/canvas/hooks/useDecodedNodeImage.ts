// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { NodeBodyImage } from '@/features/canvas/application/imageData';
import { canvasPreviewDecodeQueue } from '@/features/canvas/application/canvasPreviewDecodeQueue';

/** Commit src and its measurement descriptor together, only within one asset. */
export function useDecodedNodeImage(candidate: NodeBodyImage | null, mediaKey: string, measurementKey = '') {
  const key = JSON.stringify([mediaKey, measurementKey]);
  const [accepted, setAccepted] = useState({ key, image: candidate });
  const [failed, setFailed] = useState(false);
  const ready = useRef('');
  const previous = accepted.key === key ? accepted.image : null;
  const canHold = Boolean(previous && ready.current === JSON.stringify([key, previous.src]));
  const displayed = candidate && canHold ? previous : candidate;
  const src = candidate?.src;
  const original = candidate?.original;
  const downscaled = candidate?.downscaled;
  const maxEdge = candidate?.maxEdge;

  useLayoutEffect(() => {
    setFailed(false);
    const image = src && original !== undefined && downscaled !== undefined
      ? { src, original, downscaled, maxEdge: maxEdge ?? null } : null;
    if (!image || !canHold || previous?.src === image.src) {
      setAccepted(current => current.key === key && current.image?.src === image?.src &&
        current.image?.original === image?.original && current.image?.downscaled === image?.downscaled &&
        current.image?.maxEdge === image?.maxEdge ? current : { key, image });
      return;
    }
    let cancelled = false;
    const cancel = canvasPreviewDecodeQueue.request(image.src, success => {
      if (cancelled) return;
      if (success) {
        ready.current = JSON.stringify([key, image.src]);
        setAccepted({ key, image });
      } else setFailed(true);
    });
    return () => { cancelled = true; cancel(); };
  }, [key, src, original, downscaled, maxEdge, canHold, previous?.src]);

  const onLoad = useCallback((image: HTMLImageElement) => {
    if (displayed && image.getAttribute('src') === displayed.src && image.complete && image.naturalWidth > 0) {
      ready.current = JSON.stringify([key, displayed.src]);
    }
  }, [key, displayed]);
  return { displayed, onLoad, pending: displayed?.src !== candidate?.src && !failed, failed };
}
