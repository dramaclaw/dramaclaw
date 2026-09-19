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
import { Check, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  isContinuationRangeSupported,
  CONTINUATION_MAX_SEC,
  CONTINUATION_MIN_SEC,
  type ContinuationSelection,
} from '@/features/canvas/application/videoRangePrompt';
import { getFilmstrip, pickFrame, type FilmstripFrame } from '@/features/canvas/compose/filmstrip';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

/**
 * 智能续写的「选前置片段」条。
 *
 * 和片段重拍只差一条，但这条是本质的：续写要的是一段**真的裁出来的视频**，
 * 不是一个时间区间——模型把它当作「已经发生的部分」，靠它推后面。所以确认之后
 * 走的是剪辑那条管线（真裁一段落成节点），而不是把秒数写进提示词。
 *
 * 选区只有一段，长度被模型限在 4–30 秒。
 */

const THUMB_COUNT = 10;

interface VideoContinuationPanelProps {
  sourceUrl: string;
  sourceDurationSec: number;
  range: ContinuationSelection;
  isSubmitting?: boolean;
  onChange: (range: ContinuationSelection) => void;
  onExit: () => void;
  onConfirm: (range: ContinuationSelection) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const VideoContinuationPanel = memo(function VideoContinuationPanel({
  sourceUrl,
  sourceDurationSec,
  range,
  isSubmitting = false,
  onChange,
  onExit,
  onConfirm,
}: VideoContinuationPanelProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<'start' | 'end' | null>(null);
  const [frames, setFrames] = useState<FilmstripFrame[]>([]);
  const [framesState, setFramesState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setFramesState('loading');
    getFilmstrip(sourceUrl)
      .then((captured) => {
        if (cancelled) return;
        setFrames(captured);
        setFramesState(captured.length > 0 ? 'ready' : 'error');
      })
      .catch((error) => {
        console.warn('[video-continuation] filmstrip failed', error);
        if (!cancelled) setFramesState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  const secondsAt = useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current;
      if (!track || sourceDurationSec <= 0) return null;
      const rect = track.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      return ratio * sourceDurationSec;
    },
    [sourceDurationSec],
  );

  useEffect(() => {
    if (!drag) return;
    const handleMove = (event: PointerEvent) => {
      const seconds = secondsAt(event.clientX);
      if (seconds === null) return;
      // 边界只在「模型接受的长度」里滑动。拖到不合法的地方再报错，不如根本拖不过去。
      if (drag === 'start') {
        const min = Math.max(0, range.endSec - CONTINUATION_MAX_SEC);
        const max = range.endSec - CONTINUATION_MIN_SEC;
        if (max < min) return;
        onChange({ ...range, startSec: clamp(seconds, min, max) });
      } else {
        const min = range.startSec + CONTINUATION_MIN_SEC;
        const max = Math.min(sourceDurationSec, range.startSec + CONTINUATION_MAX_SEC);
        if (max < min) return;
        onChange({ ...range, endSec: clamp(seconds, min, max) });
      }
    };
    const handleUp = () => setDrag(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [drag, onChange, range, secondsAt, sourceDurationSec]);

  const supported = useMemo(() => isContinuationRangeSupported(range), [range]);
  const pct = (seconds: number) => (sourceDurationSec > 0 ? (seconds / sourceDurationSec) * 100 : 0);
  const selectedSec = Math.max(0, range.endSec - range.startSec);

  const startDrag = useCallback(
    (edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSubmitting) return;
      event.preventDefault();
      event.stopPropagation();
      setDrag(edge);
    },
    [isSubmitting],
  );

  return (
    <div
      className={`nodrag flex w-full flex-col gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-text-dark/80">
          {t('node.videoContinuation.selectSegment')}
          <span className="ml-1.5 text-text-muted/70">
            {t('node.videoContinuation.selectedDuration', { seconds: selectedSec.toFixed(1) })}
          </span>
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
          onClick={onExit}
          disabled={isSubmitting}
          title={t('node.videoContinuation.exit')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div
          ref={trackRef}
          className="relative h-14 flex-1 select-none overflow-hidden rounded-md bg-bg-dark/80"
        >
          <div className="absolute inset-0 flex">
            {Array.from({ length: THUMB_COUNT }).map((_, index) => {
              const at = (sourceDurationSec * 1000 * (index + 0.5)) / THUMB_COUNT;
              const frame = pickFrame(frames, at);
              return (
                <div
                  key={index}
                  className="h-full flex-1 bg-bg-dark/70"
                  style={{
                    backgroundImage: frame ? `url(${frame.url})` : undefined,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                />
              );
            })}
          </div>

          {framesState !== 'ready' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-text-muted/70">
              {t(
                framesState === 'loading'
                  ? 'node.videoRemake.framesLoading'
                  : 'node.videoRemake.framesFailed',
              )}
            </div>
          )}

          <div
            className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
            style={{ width: `${pct(range.startSec)}%` }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
            style={{ width: `${100 - pct(range.endSec)}%` }}
          />

          <div
            className="absolute inset-y-0 z-10 border-y-2 border-white"
            style={{ left: `${pct(range.startSec)}%`, right: `${100 - pct(range.endSec)}%` }}
          >
            <div
              className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-white"
              onPointerDown={startDrag('start')}
              title={t('node.videoRemake.dragStart')}
            >
              <div className="h-4 w-[2px] rounded-full bg-black/40" />
            </div>
            <div
              className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-white"
              onPointerDown={startDrag('end')}
              title={t('node.videoRemake.dragEnd')}
            >
              <div className="h-4 w-[2px] rounded-full bg-black/40" />
            </div>
          </div>
        </div>

        <button
          type="button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-text-muted"
          onClick={() => onConfirm(range)}
          disabled={!supported || isSubmitting}
          title={t('node.videoContinuation.confirm')}
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
        </button>
      </div>

      <p className="px-0.5 text-[11px] text-text-muted/70">
        {supported
          ? t('node.videoContinuation.hint')
          : t('node.videoContinuation.durationHint', {
              min: CONTINUATION_MIN_SEC,
              max: CONTINUATION_MAX_SEC,
            })}
      </p>
    </div>
  );
});
