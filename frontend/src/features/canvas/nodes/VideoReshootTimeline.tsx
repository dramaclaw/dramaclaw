// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { X } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { captureVideoFrames } from '@/features/canvas/application/videoFrameStrip';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  addReshootClip,
  canAddReshootClip,
  clipTimecodeToken,
  formatClipDuration,
  formatSeconds,
  MAX_RESHOOT_CLIPS,
  MAX_RESHOOT_TOTAL_MS,
  MIN_RESHOOT_CLIP_MS,
  removeReshootClip,
  resizeReshootClip,
  totalReshootMs,
  type VideoReshootClip,
} from '@/features/canvas/application/videoReshootClips';

/**
 * 「片段重拍」的时间轨道：视频卡片下面一条缩略图带，最多截 5 段。
 *
 * 这里只做手势 → 毫秒的换算，片段本身怎么放、怎么夹边界全在
 * [[videoReshootClips]]（纯函数、可单测）。onChange 回一整份新片段列表，
 * 由 VideoNode 负责落 store 并把时间码同步进 prompt。
 */

interface VideoReshootTimelineProps {
  videoUrl: string;
  durationMs: number | null | undefined;
  clips: VideoReshootClip[];
  onChange: (next: VideoReshootClip[]) => void;
}

/**
 * 轨道条自身的高度。VideoNode 要拿它把下面的操作面板 / 历史面板整体往下推 ——
 * 那两块都是相对节点底边绝对定位的，不推就会跟轨道叠在一起。
 */
export const RESHOOT_TIMELINE_HEIGHT = 72;

/** 轨道跟操作面板同宽（比卡片宽出两截），10 张会拉得太糊，12 张密度刚好。 */
const THUMB_COUNT = 12;
/** 超过这个位移才算「拖出一段」，否则当点击处理（点一下截默认 4s）。 */
const DRAW_THRESHOLD_PX = 6;

type Drag =
  | { kind: 'resize'; id: string; edge: 'start' | 'end' }
  | { kind: 'draw'; anchorMs: number; anchorX: number; id: string | null };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

let seq = 0;
function makeClipId(): string {
  seq += 1;
  return `rc-${seq}-${Math.round(performance.now())}`;
}

export const VideoReshootTimeline = memo(function VideoReshootTimeline({
  videoUrl,
  durationMs,
  clips,
  onChange,
}: VideoReshootTimelineProps) {
  const totalMs = useMemo(
    () => (typeof durationMs === 'number' && durationMs > 0 ? durationMs : null),
    [durationMs],
  );

  const trackRef = useRef<HTMLDivElement>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [thumbsState, setThumbsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const dragRef = useRef<Drag | null>(null);
  /**
   * 拖完手指抬起时浏览器还会补一发 click，且 click 的落点是 pointerdown/up 的
   * 共同祖先 —— 拖手柄拖到别处松手，这一发就打在轨道上，不挡住会凭空多一段。
   */
  const suppressClickRef = useRef(false);
  // 拖拽期间读到的永远是最新一份 clips —— 事件监听只挂一次，闭包不能吃旧值。
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    setThumbsState('loading');
    const resolved = resolveImageDisplayUrl(videoUrl);
    if (!resolved) {
      setThumbsState('error');
      return;
    }
    void captureVideoFrames(resolved, THUMB_COUNT)
      .then((frames) => {
        if (cancelled) return;
        setThumbs(frames);
        setThumbsState('ready');
      })
      .catch((error) => {
        console.warn('[video-reshoot] thumbnail extraction failed', error);
        if (!cancelled) setThumbsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [videoUrl]);

  const msAt = useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current;
      if (!track || !totalMs) return null;
      const rect = track.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      return Math.round(ratio * totalMs);
    },
    [totalMs],
  );

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !totalMs) return;
      const ms = msAt(event.clientX);
      if (ms === null) return;

      if (drag.kind === 'resize') {
        onChange(resizeReshootClip(clipsRef.current, drag.id, drag.edge, ms, totalMs));
        return;
      }

      // 空白处拖拽：越过阈值才真正开一段，之后转成拖尾巴。
      if (Math.abs(event.clientX - drag.anchorX) < DRAW_THRESHOLD_PX) return;
      if (drag.id === null) {
        const id = makeClipId();
        const startMs = Math.min(drag.anchorMs, ms);
        const endMs = Math.max(startMs + MIN_RESHOOT_CLIP_MS, Math.max(drag.anchorMs, ms));
        // 借 addReshootClip 落一段最小长度的种子，重叠/上限规则跟点击那条路一致。
        const seeded = addReshootClip(clipsRef.current, startMs, totalMs, () => id);
        if (!seeded) {
          dragRef.current = null;
          return;
        }
        dragRef.current = { ...drag, id };
        onChange(resizeReshootClip(seeded, id, 'end', endMs, totalMs));
        return;
      }
      onChange(resizeReshootClip(clipsRef.current, drag.id, 'end', ms, totalMs));
    };

    const handleUp = () => {
      const drag = dragRef.current;
      suppressClickRef.current =
        drag?.kind === 'resize' || (drag?.kind === 'draw' && drag.id !== null);
      dragRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [msAt, onChange, totalMs]);

  const startResize = useCallback(
    (id: string, edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = { kind: 'resize', id, edge };
    },
    [],
  );

  const handleTrackPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!totalMs || !canAddReshootClip(clips)) return;
      const ms = msAt(event.clientX);
      if (ms === null) return;
      event.preventDefault();
      dragRef.current = { kind: 'draw', anchorMs: ms, anchorX: event.clientX, id: null };
    },
    [clips, msAt, totalMs],
  );

  const handleTrackClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      // 拖出来的那一段已经在 pointermove 里建好了，click 不该再补一段。
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (!totalMs) return;
      const ms = msAt(event.clientX);
      if (ms === null) return;
      const next = addReshootClip(clips, ms, totalMs, makeClipId);
      if (next) onChange(next);
    },
    [clips, msAt, onChange, totalMs],
  );

  const pct = (ms: number) => (totalMs ? (ms / totalMs) * 100 : 0);
  const usedMs = totalReshootMs(clips);
  // 「截不动了」有两种原因，提示要分开说：段数满了删一段就行，预算满了得拖短。
  const countFull = clips.length >= MAX_RESHOOT_CLIPS;
  const full = !canAddReshootClip(clips);

  return (
    <div
      className={`nodrag nowheel flex w-full select-none items-center gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      style={{ height: RESHOOT_TIMELINE_HEIGHT }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        ref={trackRef}
        className={`relative h-full flex-1 overflow-hidden rounded-md bg-bg-dark/80 ${
          full ? 'cursor-default' : 'cursor-crosshair'
        }`}
        onPointerDown={handleTrackPointerDown}
        onClick={handleTrackClick}
      >
        {/* 格子数跟着实际抽到的帧数走，不写死 THUMB_COUNT —— 少抽到一帧就会在
            轨道右端留一块黑，看着像视频没铺满。 */}
        <div className="absolute inset-0 flex">
          {(thumbs.length > 0 ? thumbs : new Array<string>(THUMB_COUNT).fill('')).map(
            (thumb, index) => (
              <div
                key={index}
                className="h-full flex-1 bg-bg-dark/70"
                style={{
                  backgroundImage: thumb ? `url(${thumb})` : undefined,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              />
            ),
          )}
        </div>

        {thumbsState === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-text-muted/70">
            提取画面帧中…
          </div>
        )}
        {thumbsState === 'error' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-text-muted/70">
            画面帧加载失败
          </div>
        )}
        {thumbsState === 'ready' && clips.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-black/45 text-[11px] text-white/85">
            点击可截取新片段
          </div>
        )}

        {clips.map((clip) => (
          <div
            key={clip.id}
            className="absolute inset-y-0 z-10 rounded-md border-2 border-white bg-[#2f6bff]/75"
            style={{ left: `${pct(clip.startMs)}%`, right: `${100 - pct(clip.endMs)}%` }}
            title={clipTimecodeToken(clip)}
            // 已有片段身上的按下/点击不该再触发「截一段」——否则拖手柄顺带多一段。
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="absolute inset-y-0 left-0 flex w-3 cursor-ew-resize items-center justify-center rounded-l-md bg-white"
              onPointerDown={startResize(clip.id, 'start')}
              title="拖动以调整起点"
            >
              <div className="h-4 w-[2px] rounded-full bg-black/40" />
            </div>
            <div
              className="absolute inset-y-0 right-0 flex w-3 cursor-ew-resize items-center justify-center rounded-r-md bg-white"
              onPointerDown={startResize(clip.id, 'end')}
              title="拖动以调整终点"
            >
              <div className="h-4 w-[2px] rounded-full bg-black/40" />
            </div>
            <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
              {formatClipDuration(clip)}
            </div>
            <button
              type="button"
              className="absolute -top-1 right-3.5 z-20 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/90 transition-colors hover:bg-black"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onChange(removeReshootClip(clips, clip.id));
              }}
              title="删除该片段"
              aria-label="删除该片段"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}
      </div>

      {/* 右侧两行读数：段数 + 总时长。总时长必须常驻显示 —— 30s 是 Seedance 2.5 对
          视频素材的硬限制，拖到一半才发现顶住了、却不知道被什么顶住，最难受。 */}
      <div
        className="flex shrink-0 flex-col items-end gap-0.5 px-1 text-[11px] leading-tight tabular-nums text-text-muted/80"
        title={
          countFull
            ? '已达 5 段上限，删掉一段再截'
            : full
              ? 'Seedance 2.5 视频素材总时长上限 30s，已用满；拖短某一段再截'
              : '点击截取 4s，拖动两端微调（单段不短于 4s，合计不超过 30s）'
        }
      >
        <span>
          {clips.length}/{MAX_RESHOOT_CLIPS} 个片段
        </span>
        <span className={full && !countFull ? 'text-amber-400/90' : undefined}>
          {formatSeconds(usedMs)}/{formatSeconds(MAX_RESHOOT_TOTAL_MS)}
        </span>
      </div>
    </div>
  );
});
