// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, Loader2, Repeat, RotateCcw, Type as TypeIcon, VolumeX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { captureVideoFrames } from '@/features/canvas/application/videoFrameStrip';
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

const MIN_CLIP_MS = 200;
/**
 * 轨道按时长给像素，而不是一律跟着节点宽度走。
 *
 * 固定宽度下，44s 的素材摊到 200px 就是 220ms/px——一个像素的手抖就跳过小半秒，
 * 根本没法卡点。给足像素密度后再夹一层上下限：太短的素材不至于缩成一条缝，
 * 太长的也不会把面板拉到出屏。
 */
const PX_PER_SECOND = 14;
const MIN_TRACK_PX = 260;
const MAX_TRACK_PX = 960;
/** 一格缩略图的目标宽度：h-14(56px) 配 16:9 差不多就是这个数，拉宽了就多铺几格。 */
const THUMB_CELL_PX = 100;
const MIN_THUMBS = 6;
const MAX_THUMBS = 16;
/** 方向键单步；按住 Shift 走大步。 */
const KEY_STEP_MS = 100;
const KEY_STEP_COARSE_MS = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (seconds >= 10) return `${seconds.toFixed(1)} s`;
  return `${seconds.toFixed(2)} s`;
}

type DragMode = 'start' | 'end' | 'move';

interface DragState {
  mode: DragMode;
  rect: DOMRect;
  /** 按下瞬间的区间，move 模式靠它保持时长不变。 */
  startAtDown: number;
  endAtDown: number;
  /** 按下瞬间指针对应的时间码，move 模式用它算位移。 */
  anchorMs: number;
}

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

  const trackMinWidth = useMemo(() => {
    if (!totalMs) return MIN_TRACK_PX;
    return clamp(Math.round((totalMs / 1000) * PX_PER_SECOND), MIN_TRACK_PX, MAX_TRACK_PX);
  }, [totalMs]);

  const thumbCount = useMemo(
    () => clamp(Math.round(trackMinWidth / THUMB_CELL_PX), MIN_THUMBS, MAX_THUMBS),
    [trackMinWidth],
  );

  const committedStartMs = useMemo(() => {
    if (typeof clipStartMs === 'number') return clamp(clipStartMs, 0, totalMs ?? clipStartMs);
    return 0;
  }, [clipStartMs, totalMs]);

  const committedEndMs = useMemo(() => {
    if (typeof clipEndMs === 'number') return clamp(clipEndMs, 0, totalMs ?? clipEndMs);
    return totalMs ?? 0;
  }, [clipEndMs, totalMs]);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragMode, setDragMode] = useState<DragMode | null>(null);
  /**
   * 拖拽期间的区间只留在组件本地，松手才写回节点。
   *
   * `onChange` 落到 `updateNodeData`，那里每次调用都会压一整份画布快照并清空
   * redo 栈——按 pointermove 的频率调，一次拖拽就能压进去上百份快照，撤销记录
   * 直接被冲没。本地 draft + 松手提交让一次拖拽只留一条撤销记录。
   */
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  /** 与 draft 同步的镜像：pointerup 要在同一个事件里拿到最终值提交，来不及等 state。 */
  const draftRef = useRef<{ start: number; end: number } | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsState, setThumbsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [thumbsAttempt, setThumbsAttempt] = useState(0);

  const startMs = draft ? draft.start : committedStartMs;
  const endMs = draft ? draft.end : committedEndMs;

  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    setThumbsState('loading');
    const resolved = resolveImageDisplayUrl(videoUrl);
    if (!resolved) {
      setThumbsState('error');
      return;
    }
    void captureVideoFrames(resolved, thumbCount)
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
  }, [thumbCount, videoUrl, thumbsAttempt]);

  const commit = useCallback(
    (next: { start: number; end: number }) => {
      const patch: { clipStartMs?: number; clipEndMs?: number } = {};
      if (next.start !== committedStartMs) patch.clipStartMs = next.start;
      if (next.end !== committedEndMs) patch.clipEndMs = next.end;
      // 一次拖拽 = 一次 updateNodeData = 一条撤销记录。两端都动了也只发一个 patch。
      if (patch.clipStartMs !== undefined || patch.clipEndMs !== undefined) onChange(patch);
    },
    [committedEndMs, committedStartMs, onChange],
  );

  /** 把指针位置换算成区间。纯函数，好让键盘和指针共用同一套夹取规则。 */
  const resolveRange = useCallback(
    (drag: DragState, pointerMs: number, total: number) => {
      if (drag.mode === 'start') {
        return {
          start: clamp(pointerMs, 0, Math.max(0, drag.endAtDown - MIN_CLIP_MS)),
          end: drag.endAtDown,
        };
      }
      if (drag.mode === 'end') {
        return {
          start: drag.startAtDown,
          end: clamp(pointerMs, Math.min(drag.startAtDown + MIN_CLIP_MS, total), total),
        };
      }
      const length = drag.endAtDown - drag.startAtDown;
      const start = clamp(drag.startAtDown + (pointerMs - drag.anchorMs), 0, Math.max(0, total - length));
      return { start, end: start + length };
    },
    [],
  );

  useEffect(() => {
    if (!dragMode || !totalMs) return;

    let frame = 0;
    let pendingX: number | null = null;

    const apply = () => {
      frame = 0;
      const drag = dragRef.current;
      if (pendingX === null || !drag) return;
      const ratio = clamp((pendingX - drag.rect.left) / Math.max(drag.rect.width, 1), 0, 1);
      pendingX = null;
      const next = resolveRange(drag, Math.round(ratio * totalMs), totalMs);
      draftRef.current = next;
      setDraft(next);
    };

    // pointermove 在高刷屏上一秒能来 100+ 次，按帧合并一次就够画面用了。
    const handlePointerMove = (event: PointerEvent) => {
      pendingX = event.clientX;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const handlePointerUp = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      apply(); // 冲掉最后一帧还没画上去的位移，免得松手时回弹一格
      const final = draftRef.current;
      dragRef.current = null;
      draftRef.current = null;
      if (final) commit(final);
      setDragMode(null);
      setDraft(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [commit, dragMode, resolveRange, totalMs]);

  const startPct = totalMs ? (startMs / totalMs) * 100 : 0;
  const endPct = totalMs ? (endMs / totalMs) * 100 : 100;
  const selectionMs = Math.max(0, endMs - startMs);

  const handleSubmit = useCallback(() => {
    if (!totalMs || isSubmitting) return;
    onSubmit(startMs, endMs);
  }, [endMs, isSubmitting, onSubmit, startMs, totalMs]);

  const beginDrag = useCallback(
    (mode: DragMode, event: ReactPointerEvent<HTMLElement>) => {
      if (isSubmitting || !totalMs) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const pointerMs = Math.round(ratio * totalMs);
      const drag: DragState = {
        mode,
        rect,
        startAtDown: committedStartMs,
        endAtDown: committedEndMs,
        anchorMs: pointerMs,
      };
      dragRef.current = drag;
      // 直接从当前值起拖，不要等第一次 pointermove——否则轨道空白处按下时没有反馈。
      const initial =
        mode === 'move'
          ? { start: committedStartMs, end: committedEndMs }
          : resolveRange(drag, pointerMs, totalMs);
      draftRef.current = initial;
      setDraft(initial);
      setDragMode(mode);
    },
    [committedEndMs, committedStartMs, isSubmitting, resolveRange, totalMs],
  );

  const startDrag = useCallback(
    (mode: DragMode) => (event: ReactPointerEvent<HTMLDivElement>) => beginDrag(mode, event),
    [beginDrag],
  );

  /** 在轨道空白处按下：把离得近的那一端拉过来，顺手接上拖拽。 */
  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isSubmitting || !totalMs) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const pointerMs = Math.round(ratio * totalMs);
      if (pointerMs >= committedStartMs && pointerMs <= committedEndMs) return; // 选区内部交给 move
      const mode: DragMode =
        Math.abs(pointerMs - committedStartMs) <= Math.abs(pointerMs - committedEndMs) ? 'start' : 'end';
      beginDrag(mode, event);
    },
    [beginDrag, committedEndMs, committedStartMs, isSubmitting, totalMs],
  );

  const handleKeyDown = useCallback(
    (edge: 'start' | 'end') => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isSubmitting || !totalMs) return;
      const step = event.shiftKey ? KEY_STEP_COARSE_MS : KEY_STEP_MS;
      let next: number | null = null;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        next = (edge === 'start' ? committedStartMs : committedEndMs) - step;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        next = (edge === 'start' ? committedStartMs : committedEndMs) + step;
      } else if (event.key === 'Home') {
        next = edge === 'start' ? 0 : committedStartMs + MIN_CLIP_MS;
      } else if (event.key === 'End') {
        next = edge === 'start' ? committedEndMs - MIN_CLIP_MS : totalMs;
      }
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (edge === 'start') {
        commit({ start: clamp(next, 0, Math.max(0, committedEndMs - MIN_CLIP_MS)), end: committedEndMs });
      } else {
        commit({
          start: committedStartMs,
          end: clamp(next, Math.min(committedStartMs + MIN_CLIP_MS, totalMs), totalMs),
        });
      }
    },
    [commit, committedEndMs, committedStartMs, isSubmitting, totalMs],
  );

  // 抽到几帧就铺几格；抽不满时铺满黑格子会让人以为视频后半段是黑的。
  const cellCount = thumbs.length > 0 ? thumbs.length : thumbCount;
  // 时长气泡贴着选区中点，但不让它探出轨道两头。
  const chipLeftPct = clamp((startPct + endPct) / 2, 8, 92);

  return (
    <div
      className={`nodrag nowheel flex items-center gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
        onClick={onExit}
        disabled={isSubmitting}
        aria-label={t('canvas.videoClip.exit')}
        title={t('canvas.videoClip.exit')}
      >
        <X className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-text-dark/72 opacity-40"
        aria-label={t('canvas.videoClip.subtitleTodo')}
        title={t('canvas.videoClip.subtitleTodo')}
        disabled
      >
        <TypeIcon className="h-4 w-4" />
      </button>

      <div
        ref={trackRef}
        className="relative h-14 flex-1 select-none overflow-hidden rounded-md bg-bg-dark/80"
        // 撑宽靠 min-width：面板外层是 w-max，节点窄的时候由它把整条面板顶开，
        // 节点宽的时候 flex-1 又能继续吃满剩余空间。
        style={{ minWidth: trackMinWidth }}
        onPointerDown={handleTrackPointerDown}
      >
        {/* thumbnail strip */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: cellCount }).map((_, index) => (
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
        {/* z-30 + pointer-events-none：重试按钮要压在选区框上面才点得到，
            但整块蒙层不能吃掉把手的拖拽。 */}
        {thumbsState === 'error' && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-1.5 text-[11px] text-text-muted/70">
            <span>{t('canvas.videoClip.framesFailed')}</span>
            <button
              type="button"
              className="pointer-events-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-text-dark/80 transition-colors hover:bg-white/[0.1] hover:text-white"
              onClick={() => setThumbsAttempt((value) => value + 1)}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label="重新提取画面帧"
            >
              <RotateCcw className="h-3 w-3" />
              重试
            </button>
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
          className={`absolute inset-y-0 z-10 border-y-2 border-white ${
            isSubmitting ? '' : dragMode === 'move' ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
          onPointerDown={startDrag('move')}
        >
          <div
            role="slider"
            tabIndex={isSubmitting ? -1 : 0}
            aria-label="剪辑起点"
            aria-valuemin={0}
            aria-valuemax={totalMs ?? 0}
            aria-valuenow={startMs}
            aria-valuetext={formatSeconds(startMs)}
            // after:* 是把手的隐形热区：视觉仍是 12px 细条，实际能点到 28px 宽，
            // 选区很窄时两个把手也不会互相抢点击。
            className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-white outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
            onPointerDown={startDrag('start')}
            onKeyDown={handleKeyDown('start')}
            title={t('canvas.videoClip.dragStart')}
          >
            <div className="pointer-events-none h-4 w-[2px] rounded-full bg-black/40" />
          </div>
          <div
            role="slider"
            tabIndex={isSubmitting ? -1 : 0}
            aria-label="剪辑终点"
            aria-valuemin={0}
            aria-valuemax={totalMs ?? 0}
            aria-valuenow={endMs}
            aria-valuetext={formatSeconds(endMs)}
            className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-white outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
            onPointerDown={startDrag('end')}
            onKeyDown={handleKeyDown('end')}
            title={t('canvas.videoClip.dragEnd')}
          >
            <div className="pointer-events-none h-4 w-[2px] rounded-full bg-black/40" />
          </div>
        </div>

        {/* 拖拽中把两端的时间码顶到轨道上沿，正中留给画面 */}
        {dragMode && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-between px-1 pt-0.5 text-[10px] font-medium tabular-nums text-white/90">
            <span className="rounded bg-black/65 px-1">{formatSeconds(startMs)}</span>
            <span className="rounded bg-black/65 px-1">{formatSeconds(endMs)}</span>
          </div>
        )}

        {/* duration chip */}
        <div
          className="pointer-events-none absolute bottom-1 z-20 -translate-x-1/2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
          style={{ left: `${chipLeftPct}%` }}
        >
          {formatSeconds(selectionMs)}
        </div>
      </div>

      <button
        type="button"
        className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-text-dark/72 opacity-40"
        aria-label={t('canvas.videoClip.muteTodo')}
        title={t('canvas.videoClip.muteTodo')}
        disabled
      >
        <VolumeX className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 cursor-not-allowed items-center justify-center rounded-full text-text-dark/72 opacity-40"
        aria-label={t('canvas.videoClip.loopTodo')}
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
        aria-label={
          isSubmitting
            ? t('canvas.videoClip.submitting')
            : t('canvas.videoClip.submit')
        }
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
