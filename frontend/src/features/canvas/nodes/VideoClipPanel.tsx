// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, Loader2, Repeat, Type as TypeIcon, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  mediaNeedsCrossOrigin,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface VideoClipPanelProps {
  videoUrl: string;
  durationMs: number | null | undefined;
  clipStartMs: number | null | undefined;
  clipEndMs: number | null | undefined;
  isSubmitting?: boolean;
  onChange: (patch: { clipStartMs?: number | null; clipEndMs?: number | null }) => void;
  onExit: () => void;
  onSubmit: (start: number, end: number) => void;
}

const THUMB_COUNT = 8;
const MIN_CLIP_MS = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (seconds >= 10) return `${seconds.toFixed(1)} s`;
  return `${seconds.toFixed(2)} s`;
}

/**
 * Render N evenly-spaced thumbnails for a video via a hidden <video> + <canvas>.
 *
 * Notes:
 * - Cross-origin CDN media (absolute http(s) URL, the production case) loads
 *   with `crossOrigin='anonymous'` so the frames can be drawn to a canvas and
 *   exported without tainting it. Same-origin `/static/*` (the dev vite proxy)
 *   skips it — that origin doesn't echo `Access-Control-Allow-Origin`, and a
 *   same-origin draw is never tainted.
 * - We wait for `loadeddata` (one usable frame) before the first seek so the
 *   first drawImage doesn't render the black initial buffer.
 */
async function captureFrames(src: string, count: number): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('canvas context unavailable'));
      return;
    }

    const cleanup = () => {
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignored
      }
    };

    const fail = (reason: unknown) => {
      cleanup();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    video.addEventListener('error', () => fail('video element error'));

    video.addEventListener('loadeddata', () => {
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        fail('invalid duration for thumbnails');
        return;
      }
      const targetWidth = 160;
      const ratio = video.videoHeight / Math.max(video.videoWidth, 1);
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(targetWidth * ratio));

      const thumbs: string[] = [];
      let index = 0;

      const seekNext = () => {
        if (index >= count) {
          cleanup();
          resolve(thumbs);
          return;
        }
        const t = (duration * (index + 0.5)) / count;
        video.currentTime = clamp(t, 0, Math.max(0, duration - 0.05));
      };

      video.addEventListener('seeked', () => {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
        } catch (error) {
          fail(error);
          return;
        }
        index += 1;
        seekNext();
      });

      seekNext();
    });

    video.src = src;
    try {
      video.load();
    } catch {
      // ignored — `src` assignment already kicks off the fetch in most browsers
    }
  });
}

type DragMode = 'start' | 'end' | null;

export const VideoClipPanel = memo(function VideoClipPanel({
  videoUrl,
  durationMs,
  clipStartMs,
  clipEndMs,
  isSubmitting = false,
  onChange,
  onExit,
  onSubmit,
}: VideoClipPanelProps) {
  const { t } = useTranslation();
  const totalMs = useMemo(() => {
    if (typeof durationMs === 'number' && durationMs > 0) return durationMs;
    return null;
  }, [durationMs]);

  const startMs = useMemo(() => {
    if (typeof clipStartMs === 'number') return clamp(clipStartMs, 0, totalMs ?? clipStartMs);
    return 0;
  }, [clipStartMs, totalMs]);

  const endMs = useMemo(() => {
    if (typeof clipEndMs === 'number') return clamp(clipEndMs, 0, totalMs ?? clipEndMs);
    return totalMs ?? 0;
  }, [clipEndMs, totalMs]);

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsState, setThumbsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    setThumbsState('loading');
    const resolved = resolveImageDisplayUrl(videoUrl);
    if (!resolved) {
      setThumbsState('error');
      return;
    }
    void captureFrames(resolved, THUMB_COUNT)
      .then((frames) => {
        if (cancelled) return;
        setThumbs(frames);
        setThumbsState('ready');
      })
      .catch((error) => {
        console.warn('[video-clip] thumbnail extraction failed', error);
        if (!cancelled) setThumbsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [videoUrl]);

  const setStart = useCallback(
    (nextStart: number) => {
      if (!totalMs) return;
      const clamped = clamp(nextStart, 0, Math.max(0, endMs - MIN_CLIP_MS));
      onChange({ clipStartMs: clamped });
    },
    [endMs, onChange, totalMs],
  );

  const setEnd = useCallback(
    (nextEnd: number) => {
      if (!totalMs) return;
      const clamped = clamp(nextEnd, startMs + MIN_CLIP_MS, totalMs);
      onChange({ clipEndMs: clamped });
    },
    [onChange, startMs, totalMs],
  );

  useEffect(() => {
    if (!dragMode || !totalMs) return;
    const track = trackRef.current;
    if (!track) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const ms = Math.round(ratio * totalMs);
      if (dragMode === 'start') setStart(ms);
      else if (dragMode === 'end') setEnd(ms);
    };

    const handlePointerUp = () => setDragMode(null);

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [dragMode, setEnd, setStart, totalMs]);

  const startPct = totalMs ? (startMs / totalMs) * 100 : 0;
  const endPct = totalMs ? (endMs / totalMs) * 100 : 100;
  const selectionMs = Math.max(0, endMs - startMs);

  const handleSubmit = useCallback(() => {
    if (!totalMs || isSubmitting) return;
    onSubmit(startMs, endMs);
  }, [endMs, isSubmitting, onSubmit, startMs, totalMs]);

  const startDrag = useCallback(
    (mode: DragMode) => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSubmitting) return;
      event.preventDefault();
      event.stopPropagation();
      setDragMode(mode);
    },
    [isSubmitting],
  );

  return (
    <div
      className={`nodrag flex w-full items-center gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
        onClick={onExit}
        disabled={isSubmitting}
        title={t('canvas.videoClip.exit')}
      >
        <X className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/72"
        title={t('canvas.videoClip.subtitleTodo')}
        disabled
      >
        <TypeIcon className="h-4 w-4" />
      </button>

      <div
        ref={trackRef}
        className="relative h-14 flex-1 select-none overflow-hidden rounded-md bg-bg-dark/80"
      >
        {/* thumbnail strip */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: THUMB_COUNT }).map((_, index) => (
            <div
              key={index}
              className="h-full flex-1 bg-bg-dark/70"
              style={{
                backgroundImage: thumbs[index] ? `url(${thumbs[index]})` : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          ))}
        </div>

        {thumbsState === 'loading' && thumbs.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-text-muted/70">
            {t('canvas.videoClip.extractingFrames')}
          </div>
        )}
        {thumbsState === 'error' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-text-muted/70">
            {t('canvas.videoClip.framesFailed')}
          </div>
        )}

        {/* dark mask outside the selection */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
          style={{ width: `${startPct}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
          style={{ width: `${100 - endPct}%` }}
        />

        {/* selection rectangle (top/bottom borders + inner handles) */}
        <div
          className="absolute inset-y-0 z-10 border-y-2 border-white"
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
        >
          <div
            className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-white"
            onPointerDown={startDrag('start')}
            title={t('canvas.videoClip.dragStart')}
          >
            <div className="h-4 w-[2px] rounded-full bg-black/40" />
          </div>
          <div
            className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-white"
            onPointerDown={startDrag('end')}
            title={t('canvas.videoClip.dragEnd')}
          >
            <div className="h-4 w-[2px] rounded-full bg-black/40" />
          </div>
        </div>

        {/* duration chip */}
        <div
          className="pointer-events-none absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white"
          style={{ left: `calc((${startPct}% + ${endPct}%) / 2)` }}
        >
          {formatSeconds(selectionMs)}
        </div>
      </div>

      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/72"
        title={t('canvas.videoClip.muteTodo')}
        disabled
      >
        <VolumeX className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/72"
        title={t('canvas.videoClip.loopTodo')}
        disabled
      >
        <Repeat className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-text-muted"
        onClick={handleSubmit}
        disabled={!totalMs || selectionMs < MIN_CLIP_MS || isSubmitting}
        title={
          isSubmitting
            ? t('canvas.videoClip.submitting')
            : t('canvas.videoClip.submit')
        }
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
      </button>
    </div>
  );
});
