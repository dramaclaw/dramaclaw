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
import { Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  formatRangeDurationLabel,
  getInsertableRemakeGaps,
  insertRemakeRange,
  resizeRemakeRange,
  validateRemakeRanges,
  SEGMENT_REMAKE_MAX_RANGES,
  type RangeRejection,
  type TimeRange,
} from '@/features/canvas/application/videoRangePrompt';
import { getFilmstrip, pickFrame, type FilmstripFrame } from '@/features/canvas/compose/filmstrip';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

/**
 * 片段重拍的区间选择条。
 *
 * 这个面板只管**选区间和写意图**，不管提交——重拍走的是视频节点原本的
 * 视频编辑（videoEdit）生成链路，提交按钮仍是节点自己的那一个。把选区做成
 * 独立面板而不是塞进生成面板，是因为它需要整条时间轴的宽度。
 *
 * 落位、拖拽边界、增删段的规则全部在 `videoRangePrompt` 里，这里只负责把
 * 指针位置换算成秒再交给它。界面不自己判断「这样合不合法」——两边各判一次，
 * 迟早会判得不一样。
 */

const THUMB_COUNT = 10;

interface VideoRemakePanelProps {
  sourceUrl: string;
  sourceDurationSec: number;
  ranges: TimeRange[];
  isSubmitting?: boolean;
  onChange: (ranges: TimeRange[]) => void;
  /** 清空所选片段。不是「退出重拍」——这个节点本身就是重拍节点，退不出去。 */
  onClear: () => void;
}

type DragState = { id: string; edge: 'start' | 'end' } | null;

function rejectionMessage(
  rejection: RangeRejection,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (rejection.code) {
    case 'source_too_short':
      return t('node.videoRemake.error.sourceTooShort', { min: rejection.minSec });
    case 'too_many_ranges':
      return t('node.videoRemake.error.tooManyRanges', { max: rejection.max });
    case 'range_out_of_bounds':
      return t('node.videoRemake.error.outOfBounds');
    case 'range_too_short':
      return t('node.videoRemake.error.rangeTooShort', { min: rejection.minSec });
    case 'range_too_long':
      return t('node.videoRemake.error.rangeTooLong', { max: rejection.maxSec });
    case 'ranges_overlap':
      return t('node.videoRemake.error.overlap');
    case 'gap_too_short':
      return t('node.videoRemake.error.gapTooShort', { min: rejection.minSec });
    default:
      return '';
  }
}

export const VideoRemakePanel = memo(function VideoRemakePanel({
  sourceUrl,
  sourceDurationSec,
  ranges,
  isSubmitting = false,
  onChange,
  onClear,
}: VideoRemakePanelProps) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
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
        console.warn('[video-remake] filmstrip failed', error);
        if (!cancelled) setFramesState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  const validation = useMemo(
    () => validateRemakeRanges({ ranges, sourceDurationSec }),
    [ranges, sourceDurationSec],
  );
  const insertable = useMemo(
    () => getInsertableRemakeGaps(ranges, sourceDurationSec),
    [ranges, sourceDurationSec],
  );

  const secondsAt = useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current;
      if (!track || sourceDurationSec <= 0) return null;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(Math.max((clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
      return ratio * sourceDurationSec;
    },
    [sourceDurationSec],
  );

  useEffect(() => {
    if (!drag) return;
    const handleMove = (event: PointerEvent) => {
      const seconds = secondsAt(event.clientX);
      if (seconds === null) return;
      onChange(
        resizeRemakeRange({ ranges, id: drag.id, edge: drag.edge, valueSec: seconds, sourceDurationSec }),
      );
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
  }, [drag, onChange, ranges, secondsAt, sourceDurationSec]);

  const handleTrackClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSubmitting || drag) return;
      const seconds = secondsAt(event.clientX);
      if (seconds === null) return;
      // 点在已有段上时 insert 会原样返回，这里据此判断「是选中还是新增」，
      // 不再自己算一遍区间包含关系。
      const next = insertRemakeRange({
        ranges,
        atSec: seconds,
        sourceDurationSec,
        id: `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      });
      if (next.length === ranges.length) return;
      onChange(next);
      setActiveId(next.find((range) => !ranges.some((old) => old.id === range.id))?.id ?? null);
    },
    [drag, isSubmitting, onChange, ranges, secondsAt, sourceDurationSec],
  );

  const removeRange = useCallback(
    (id: string) => {
      onChange(ranges.filter((range) => range.id !== id));
      setActiveId((current) => (current === id ? null : current));
    },
    [onChange, ranges],
  );

  const setIntent = useCallback(
    (id: string, intent: string) => {
      onChange(ranges.map((range) => (range.id === id ? { ...range, intent } : range)));
    },
    [onChange, ranges],
  );

  const startDrag = useCallback(
    (id: string, edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSubmitting) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveId(id);
      setDrag({ id, edge });
    },
    [isSubmitting],
  );

  const active = ranges.find((range) => range.id === activeId) ?? null;
  const pct = (seconds: number) => (sourceDurationSec > 0 ? (seconds / sourceDurationSec) * 100 : 0);

  return (
    <div
      className={`nodrag nowheel flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-text-dark/80">
          {t('node.videoRemake.title')}
          <span className="ml-1.5 text-text-muted/70">
            {t('node.videoRemake.rangeCount', {
              selected: ranges.length,
              max: SEGMENT_REMAKE_MAX_RANGES,
            })}
          </span>
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
          onClick={onClear}
          disabled={isSubmitting || ranges.length === 0}
          title={t('node.videoRemake.clearAll')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        ref={trackRef}
        className="relative h-12 w-full shrink-0 select-none overflow-hidden rounded-md bg-bg-dark/80"
        onPointerDown={handleTrackClick}
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

        {/* 可以在这里加一段的空隙：给一条细底纹，点哪儿加哪儿 */}
        {insertable.map((gap) => (
          <div
            key={`gap-${gap.startSec}`}
            className="pointer-events-none absolute bottom-0 h-[3px] rounded-full bg-white/25"
            style={{ left: `${pct(gap.startSec)}%`, width: `${pct(gap.endSec - gap.startSec)}%` }}
          />
        ))}

        {ranges.map((range) => {
          const isActive = range.id === activeId;
          return (
            <div
              key={range.id}
              className={`absolute inset-y-0 z-10 border-y-2 ${
                isActive ? 'border-white bg-white/10' : 'border-white/70'
              }`}
              style={{
                left: `${pct(range.startSec)}%`,
                width: `${pct(range.endSec - range.startSec)}%`,
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
                setActiveId(range.id);
              }}
            >
              <div
                className="absolute inset-y-0 left-0 flex w-2.5 cursor-ew-resize items-center justify-center rounded-l-md bg-white"
                onPointerDown={startDrag(range.id, 'start')}
                title={t('node.videoRemake.dragStart')}
              >
                <div className="h-4 w-[2px] rounded-full bg-black/40" />
              </div>
              <div
                className="absolute inset-y-0 right-0 flex w-2.5 cursor-ew-resize items-center justify-center rounded-r-md bg-white"
                onPointerDown={startDrag(range.id, 'end')}
                title={t('node.videoRemake.dragEnd')}
              >
                <div className="h-4 w-[2px] rounded-full bg-black/40" />
              </div>
              <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {formatRangeDurationLabel(range)}
              </div>
            </div>
          );
        })}
      </div>

      {active ? (
        <div className="flex items-start gap-2">
          <textarea
            className="h-[44px] flex-1 resize-none rounded-md bg-bg-dark/70 px-2 py-1.5 text-[12px] text-text-dark outline-none placeholder:text-text-muted/60"
            value={active.intent ?? ''}
            placeholder={t('node.videoRemake.intentPlaceholder')}
            disabled={isSubmitting}
            onChange={(event) => setIntent(active.id, event.target.value)}
          />
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-dark/70 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => removeRange(active.id)}
            disabled={isSubmitting}
            title={t('node.videoRemake.remove')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <p className="line-clamp-2 px-0.5 text-[11px] leading-snug text-text-muted/70">
          {ranges.length === 0
            ? t('node.videoRemake.wholeHint')
            : t('node.videoRemake.selectHint')}
        </p>
      )}

      {validation.rejections.length > 0 && (
        <ul className="flex max-h-[42px] flex-col gap-0.5 overflow-auto rounded-md bg-red-500/15 px-2 py-1 text-[11px] leading-snug text-red-300">
          {validation.rejections.map((rejection) => (
            <li key={rejection.code}>{rejectionMessage(rejection, t)}</li>
          ))}
        </ul>
      )}
    </div>
  );
});
