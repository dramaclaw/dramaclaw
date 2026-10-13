import { useCallback, useEffect, useRef } from 'react';

/** Hold the outgoing decoded frame until the replacement video can paint. */
export function useStoryFrameTransition() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasFrameRef = useRef(false);
  const cancelPendingRef = useRef<(() => void) | null>(null);

  const cancelPending = useCallback(() => {
    cancelPendingRef.current?.();
    cancelPendingRef.current = null;
  }, []);

  const clearFrame = useCallback(() => {
    cancelPending();
    hasFrameRef.current = false;
    if (canvasRef.current) canvasRef.current.style.opacity = '0';
  }, [cancelPending]);

  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    cancelPending();
    const previous = videoRef.current;
    const canvas = canvasRef.current;
    if (!video && previous && canvas && previous.readyState >= 2
      && previous.videoWidth > 0 && previous.videoHeight > 0) {
      hasFrameRef.current = false;
      try {
        canvas.width = previous.videoWidth;
        canvas.height = previous.videoHeight;
        const context = canvas.getContext('2d');
        if (context) {
          // Drawing is allowed for cross-origin media; no pixel read/export is needed.
          context.drawImage(previous, 0, 0);
          canvas.style.transition = 'none';
          canvas.style.opacity = '1';
          hasFrameRef.current = true;
        }
      } catch {
        // Unsupported/protected frames fall back to the player's loading cover.
        hasFrameRef.current = false;
        canvas.style.opacity = '0';
      }
    }
    videoRef.current = video;
  }, [cancelPending]);

  const revealFrame = useCallback((video: HTMLVideoElement, onReady: () => void) => {
    cancelPending();
    let frameRequest: number | undefined;
    let paintRequest = 0;
    const reveal = () => {
      if (videoRef.current !== video) return;
      cancelPendingRef.current = null;
      if (canvasRef.current) {
        canvasRef.current.style.transition = '';
        canvasRef.current.style.opacity = '0';
      }
      hasFrameRef.current = false;
      onReady();
    };
    if (typeof video.requestVideoFrameCallback === 'function' && !video.paused) {
      frameRequest = video.requestVideoFrameCallback(reveal);
    } else {
      // Paused playback and older browsers still get a paint with the cover held.
      paintRequest = requestAnimationFrame(() => {
        paintRequest = requestAnimationFrame(reveal);
      });
    }
    cancelPendingRef.current = () => {
      if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
      cancelAnimationFrame(paintRequest);
    };
  }, [cancelPending]);

  useEffect(() => cancelPending, [cancelPending]);
  return { videoRef, canvasRef, hasFrameRef, attachVideo, revealFrame, clearFrame };
}
