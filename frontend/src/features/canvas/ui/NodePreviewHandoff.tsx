// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export interface NodePreviewSnapshot {
  src: string;
  width: number;
  height: number;
  objectFit: CSSProperties['objectFit'];
  identity: string;
}

/** Capture only pixels already available; the handoff must never start a video. */
export function captureNodePreview(shell: HTMLDivElement | null, identity: string): NodePreviewSnapshot | null {
  const image = shell?.querySelector('img');
  if (!shell || !image?.complete || !image.naturalWidth) return null;
  return {
    src: image.currentSrc || image.src,
    width: Number.parseFloat(shell.style.width),
    height: Number.parseFloat(shell.style.height),
    objectFit: (getComputedStyle(image).objectFit || 'contain') as CSSProperties['objectFit'],
    identity,
  };
}

/** A short-lived, geometry-free cover while the full node's body image decodes. */
export function NodePreviewHandoff({ snapshot, onDone }: {
  snapshot: NodePreviewSnapshot;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const finishTransition = useRef(() => {});
  const [fading, setFading] = useState(false);
  useLayoutEffect(() => {
    const root = ref.current?.parentElement;
    if (!root) return;
    let cancelled = false;
    let finished = false;
    let generation = 0;
    let isFading = false;
    let frame: number | null = null;
    let missingTimer: number | undefined;
    let fadeTimer: number | undefined;
    let target: HTMLImageElement | null = null;
    let targetKey = '';
    let decodedImage: HTMLImageElement | null = null;
    let decodingSrc = '';
    setFading(false);
    const stopFade = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.clearTimeout(fadeTimer);
      isFading = false;
      setFading(false);
    };
    const finish = () => {
      if (cancelled || finished) return;
      finished = true;
      cleanup();
      onDone();
    };
    finishTransition.current = () => { if (isFading) finish(); };
    const ready = (isCurrent: () => boolean) => {
      if (cancelled || finished || !isCurrent()) return;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        finish();
        return;
      }
      // Paint the old cover once before opacity changes, including cache hits.
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!cancelled && !finished && isCurrent()) {
            isFading = true;
            setFading(true);
            // Covers a lost transitionend without limiting a slow image load.
            fadeTimer = window.setTimeout(() => { if (isCurrent()) finish(); }, 500);
          }
        });
      });
    };
    const inspect = () => {
      if (cancelled || finished) return;
      const video = root.querySelector<HTMLVideoElement>('video[data-canvas-preview]');
      if (video && video.readyState >= 2) { finish(); return; }
      const image = root.querySelector<HTMLImageElement>('img[data-canvas-preview]');
      const key = image ? [image.getAttribute('src'), image.getAttribute('srcset'), image.getAttribute('sizes'), image.currentSrc].join('\n') : '';
      if (image !== target || key !== targetKey) {
        target = image; targetKey = key; generation++;
        decodedImage = null; decodingSrc = ''; stopFade();
      }
      if ((image && (image.getAttribute('src') || image.getAttribute('srcset'))) || video) {
        window.clearTimeout(missingTimer); missingTimer = undefined;
      } else if (missingTimer === undefined) {
        missingTimer = window.setTimeout(finish, 5000);
      }
      if (image?.complete && !image.naturalWidth && (image.getAttribute('src') || image.getAttribute('srcset'))) {
        finish(); return; // Already failed before listeners were attached.
      }
      if (!image?.complete || !image.naturalWidth) return;
      const src = image.currentSrc || image.src;
      if (decodedImage === image && decodingSrc === src) return;
      decodedImage = image;
      decodingSrc = src;
      const token = generation;
      const isCurrent = () => !finished && !cancelled && generation === token && image.isConnected && image.complete && image.naturalWidth > 0 &&
        [image.getAttribute('src'), image.getAttribute('srcset'), image.getAttribute('sizes'), image.currentSrc].join('\n') === key &&
        root.querySelector('img[data-canvas-preview]') === image && (image.currentSrc || image.src) === src;
      const complete = () => {
        ready(isCurrent);
      };
      if (typeof image.decode === 'function') {
        try { void image.decode().then(complete, () => { if (isCurrent()) finish(); }); }
        catch { if (isCurrent()) finish(); }
      } else complete();
    };
    const failed = (event: Event) => {
      if (event.target === root.querySelector('img[data-canvas-preview]')) finish();
    };
    root.addEventListener('load', inspect, true);
    root.addEventListener('loadeddata', inspect, true);
    root.addEventListener('error', failed, true);
    // Covers lazy component/image insertion; exists only during this handoff.
    const observer = new MutationObserver(inspect);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes'] });
    function cleanup() {
      window.clearTimeout(missingTimer);
      window.clearTimeout(fadeTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      root!.removeEventListener('load', inspect, true);
      root!.removeEventListener('loadeddata', inspect, true);
      root!.removeEventListener('error', failed, true);
    }
    inspect();
    return () => {
      cancelled = true;
      cleanup();
      finishTransition.current = () => {};
    };
  }, [onDone, snapshot]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`dc-node-preview-handoff${fading ? ' dc-node-preview-handoff--fading' : ''}`}
      style={{ width: snapshot.width, height: snapshot.height }}
      onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === 'opacity') finishTransition.current(); }}
    >
      <img src={snapshot.src} alt="" draggable={false} style={{ objectFit: snapshot.objectFit }} />
    </div>
  );
}
