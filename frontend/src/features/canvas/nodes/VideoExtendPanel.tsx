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
import { Loader2, RotateCcw, X } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { captureVideoFrames } from '@/features/canvas/application/videoFrameStrip';
import {
  MAX_EXTEND_CLIP_MS,
  MIN_EXTEND_CLIP_MS,
  defaultExtendRange,
  extendClipBoundMessage,
  isExtendRangeSubmittable,
  resolveExtendRange,
  type ExtendClipBound,
  type ExtendDragAnchor,
  type ExtendDragMode,
  type ExtendClipRange,
} from '@/features/canvas/application/videoExtendClip';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface VideoExtendPanelProps {
  videoUrl: string;
  durationMs: number | null | undefined;
  isSubmitting?: boolean;
  onExit: () => void;
  onConfirm: (range: ExtendClipRange) => void;
}

/** 与 VideoClipPanel 同一套换算：轨道按时长给像素，再夹上下限。 */
const PX_PER_SECOND = 14;
const MIN_TRACK_PX = 280;
const MAX_TRACK_PX = 960;
const THUMB_CELL_PX = 100;
const MIN_THUMBS = 6;
const MAX_THUMBS = 16;
const KEY_STEP_MS = 100;
const KEY_STEP_COARSE_MS = 1000;
/** 顶到边界的提示停留时长。够读完一行，又不会挡着下一次拖拽。 */
const BOUND_HINT_MS = 2200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `15.07 秒`。两位小数是设计稿的口径——续写对前情长度敏感，取整会看不出刚过 4s。 */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)} 秒`;
}

/**
 * 「智能续写」的前置视频选段轨道：挂在**源**视频节点底下，只截一段，4~30s。
 *
 * 和剪辑条的差别不只是少了几个按钮：剪辑是把选中的那段裁出来当结果，续写是把选中
 * 的那段当输入，所以这里没有「提交后原地替换」的概念，确认之后落的是一个下游新节点
 * （见 VideoNode 的 handleExtendConfirm）。轨道本身不写任何节点数据，选区只活在
 * 组件本地——用户可能反复拖十几次才拍板，每一次都写 store 会把撤销栈冲干净。
 */
export const VideoExtendPanel = memo(function VideoExtendPanel({
  videoUrl,
  durationMs,
  isSubmitting = false,
  onExit,
  onConfirm,
}: VideoExtendPanelProps) {
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

  const [range, setRange] = useState<ExtendClipRange>(() => defaultExtendRange(totalMs ?? 0));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // 素材时长是异步读出来的（metadata 回来之前 durationMs 为 null），拿到之后
  // 才谈得上默认选区。所以这里跟着 totalMs 重算，而不是只在挂载时取一次。
  useEffect(() => {
    if (!totalMs) return;
    setRange(defaultExtendRange(totalMs));
  }, [totalMs]);

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ExtendDragAnchor | null>(null);
  const [dragMode, setDragMode] = useState<ExtendDragMode | null>(null);
  const [boundHint, setBoundHint] = useState<ExtendClipBound>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsState, setThumbsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [thumbsAttempt, setThumbsAttempt] = useState(0);

  // 提示是「刚才顶到边了」，不是一个持续状态：不自己退场的话，用户松手后它还挂着，
  // 下一次正常拖拽也被它盖住。
  useEffect(() => {
    if (!boundHint) return;
    const timer = setTimeout(() => setBoundHint(null), BOUND_HINT_MS);
    return () => clearTimeout(timer);
  }, [boundHint]);

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
        console.warn('[video-extend] thumbnail extraction failed', error);
        if (!cancelled) setThumbsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [thumbCount, videoUrl, thumbsAttempt]);

  useEffect(() => {
    if (!dragMode || !totalMs) return;

    let frame = 0;
    let pendingX: number | null = null;

    const apply = () => {
      frame = 0;
      const anchor = dragRef.current;
      const track = trackRef.current;
      if (pendingX === null || !anchor || !track) return;
      const rect = track.getBoundingClientRect();
      const ratio = clamp((pendingX - rect.left) / Math.max(rect.width, 1), 0, 1);
      pendingX = null;
      const next = resolveExtendRange(anchor, Math.round(ratio * totalMs), totalMs);
      setRange({ startMs: next.startMs, endMs: next.endMs });
      if (next.bound) setBoundHint(next.bound);
    };

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
      dragRef.current = null;
      setDragMode(null);
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
  }, [dragMode, totalMs]);

  const beginDrag = useCallback(
    (mode: ExtendDragMode, event: ReactPointerEvent<HTMLElement>) => {
      if (isSubmitting || !totalMs) return;
      const track = trackRef.current;
      if (!track) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = track.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const current = rangeRef.current;
      dragRef.current = {
        mode,
        startAtDown: current.startMs,
        endAtDown: current.endMs,
        anchorMs: Math.round(ratio * totalMs),
      };
      setDragMode(mode);
    },
    [isSubmitting, totalMs],
  );

  const startDrag = useCallback(
    (mode: ExtendDragMode) => (event: ReactPointerEvent<HTMLDivElement>) => beginDrag(mode, event),
    [beginDrag],
  );

  const handleKeyDown = useCallback(
    (edge: 'start' | 'end') => (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isSubmitting || !totalMs) return;
      const step = event.shiftKey ? KEY_STEP_COARSE_MS : KEY_STEP_MS;
      const current = rangeRef.current;
      let target: number | null = null;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        target = (edge === 'start' ? current.startMs : current.endMs) - step;
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        target = (edge === 'start' ? current.startMs : current.endMs) + step;
      } else if (event.key === 'Home') {
        target = edge === 'start' ? 0 : current.startMs;
      } else if (event.key === 'End') {
        target = edge === 'start' ? current.endMs : totalMs;
      }
      if (target === null) return;
      event.preventDefault();
      event.stopPropagation();
      // 键盘走的是和指针同一个换算，边界提示也照弹：连按方向键顶住时得有个说法。
      const next = resolveExtendRange(
        { mode: edge, startAtDown: current.startMs, endAtDown: current.endMs, anchorMs: target },
        target,
        totalMs,
      );
      setRange({ startMs: next.startMs, endMs: next.endMs });
      if (next.bound) setBoundHint(next.bound);
    },
    [isSubmitting, totalMs],
  );

  const startPct = totalMs ? (range.startMs / totalMs) * 100 : 0;
  const endPct = totalMs ? (range.endMs / totalMs) * 100 : 100;
  const selectionMs = Math.max(0, range.endMs - range.startMs);
  const canConfirm = Boolean(totalMs) && isExtendRangeSubmittable(range) && !isSubmitting;

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    onConfirm(rangeRef.current);
  }, [canConfirm, onConfirm]);

  // 抽到几帧就铺几格；抽不满时铺满黑格子会让人以为视频后半段是黑的。
  const cellCount = thumbs.length > 0 ? thumbs.length : thumbCount;
  const chipLeftPct = clamp((startPct + endPct) / 2, 8, 92);
  const hintMessage = extendClipBoundMessage(boundHint);
  // 提示挂在被顶住的那一端下面：拖左把手时贴左，拖右把手时贴右，视线不用来回找。
  const hintLeftPct = clamp(dragMode === 'start' ? startPct : endPct, 4, 96);

  return (
    <div className="relative">
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
          aria-label="退出续写截取"
          title="退出续写截取"
        >
          <X className="h-4 w-4" />
        </button>

        {/* 轨道外面再套一层：提示要贴着被顶住的那一端弹出来，而百分比只有相对
            轨道本身才对得上；轨道自己是 overflow-hidden 的，提示挂在里面会被裁掉。 */}
        <div className="relative flex-1" style={{ minWidth: trackMinWidth }}>
        <div
          ref={trackRef}
          className="relative h-14 w-full select-none overflow-hidden rounded-md bg-bg-dark/80"
        >
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
              提取画面帧中…
            </div>
          )}
          {/* z-30 + pointer-events-none：重试按钮要压在选区框上面才点得到，
              但整块蒙层不能吃掉把手的拖拽。 */}
          {thumbsState === 'error' && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-1.5 text-[11px] text-text-muted/70">
              <span>画面帧加载失败</span>
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

          {/* 选区外压暗 */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
            style={{ width: `${startPct}%` }}
          />
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
            style={{ width: `${100 - endPct}%` }}
          />

          {/* 选区内部不铺色：那块正是要对着画面挑「续到哪儿」的地方。只有两端的
              把手带蓝，跟片段重拍的轨道保持同一套观感。 */}
          <div
            className={`absolute inset-y-0 z-10 ${
              isSubmitting ? '' : dragMode === 'move' ? 'cursor-grabbing' : 'cursor-grab'
            }`}
            style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
            onPointerDown={startDrag('move')}
          >
            <div
              role="slider"
              tabIndex={isSubmitting ? -1 : 0}
              aria-label="续写片段起点"
              aria-valuemin={0}
              aria-valuemax={totalMs ?? 0}
              aria-valuenow={range.startMs}
              aria-valuetext={formatDuration(range.startMs)}
              // after:* 是把手的隐形热区：视觉仍是细条，实际能点到 28px 宽。
              className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-[#2f6bff] outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
              onPointerDown={startDrag('start')}
              onKeyDown={handleKeyDown('start')}
              title="拖动或用方向键调整起点"
            >
              <div className="pointer-events-none h-4 w-[2px] rounded-full bg-white/85" />
            </div>
            <div
              role="slider"
              tabIndex={isSubmitting ? -1 : 0}
              aria-label="续写片段终点"
              aria-valuemin={0}
              aria-valuemax={totalMs ?? 0}
              aria-valuenow={range.endMs}
              aria-valuetext={formatDuration(range.endMs)}
              className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-[#2f6bff] outline-none after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-sky-400"
              onPointerDown={startDrag('end')}
              onKeyDown={handleKeyDown('end')}
              title="拖动或用方向键调整终点"
            >
              <div className="pointer-events-none h-4 w-[2px] rounded-full bg-white/85" />
            </div>
          </div>

          {/* duration chip */}
          <div
            className="pointer-events-none absolute top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/70 px-2 py-0.5 text-[12px] font-medium tabular-nums text-white"
            style={{ left: `${chipLeftPct}%` }}
          >
            {formatDuration(selectionMs)}
          </div>
        </div>

        {hintMessage && (
          <div
            className="pointer-events-none absolute top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/85 px-3 py-2 text-[12px] text-white shadow-lg"
            style={{ left: `${hintLeftPct}%` }}
            role="status"
          >
            {hintMessage}
          </div>
        )}
        </div>

        <button
          type="button"
          className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium text-text-dark transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:text-text-muted/50 disabled:hover:bg-transparent"
          onClick={handleConfirm}
          disabled={!canConfirm}
          title={
            totalMs && totalMs < MIN_EXTEND_CLIP_MS
              ? `视频不足 ${MIN_EXTEND_CLIP_MS / 1000} 秒，无法续写`
              : selectionMs > MAX_EXTEND_CLIP_MS
                ? (extendClipBoundMessage('max') ?? undefined)
                : undefined
          }
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          确认续写
        </button>
      </div>
    </div>
  );
});
