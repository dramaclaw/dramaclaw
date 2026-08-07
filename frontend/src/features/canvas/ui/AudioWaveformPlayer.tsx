// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';

type AudioWaveformPlayerProps = {
  src: string;
  /** 已知时长(毫秒),用于在波形解码完成前先渲染滑块范围。 */
  durationMs?: number | null;
  /** 元数据加载后回传真实时长(毫秒)。 */
  onLoadedDuration?: (ms: number) => void;
  /**
   * 播放态变化回调。播放态是本组件的内部 state,而画布的 LOD 换壳决策发生在
   * 节点组件之外(withLodShell),读不到,所以要往外抛一份。卸载时保证补一次
   * false,避免留下陈旧的「播放中」标记。
   */
  onPlayingChange?: (playing: boolean) => void;
};

// 模块级波形峰值缓存:同一 src 只解码一次。decodeAudioData 开销不小,
// 且节点重渲染 / 重新挂载很频繁,缓存能避免重复拉取与解码。
// 加 LRU 上限,防止画布里音频节点很多 / 长会话不断换素材时无界增长。
const PEAKS_CACHE_MAX = 80;
const peaksCache = new Map<string, Float32Array>();

function cachePeaks(src: string, peaks: Float32Array): void {
  // 命中即刷新到「最近使用」末尾。
  peaksCache.delete(src);
  peaksCache.set(src, peaks);
  while (peaksCache.size > PEAKS_CACHE_MAX) {
    const oldest = peaksCache.keys().next().value;
    if (oldest === undefined) break;
    peaksCache.delete(oldest);
  }
}

const ACCENT = 'rgb(56, 189, 248)';
const TRACK = 'rgba(255, 255, 255, 0.22)';
const PX_PER_SEC = 72; // 波形滚动缩放:每秒占用的像素宽度
const BUCKETS_PER_SEC = 140; // 峰值采样密度
const BAR_STEP = 3; // 相邻波形条的像素间距
const BAR_WIDTH = 2;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 把解码后的音频降采样成 [0,1] 区间的峰值数组,用于绘制波形条。 */
function computePeaks(buffer: AudioBuffer): Float32Array {
  const channel = buffer.getChannelData(0);
  const bucketCount = Math.max(1, Math.ceil(buffer.duration * BUCKETS_PER_SEC));
  const samplesPerBucket = Math.max(1, Math.floor(channel.length / bucketCount));
  const peaks = new Float32Array(bucketCount);
  let max = 0;
  for (let i = 0; i < bucketCount; i += 1) {
    const start = i * samplesPerBucket;
    const end = Math.min(channel.length, start + samplesPerBucket);
    let peak = 0;
    for (let j = start; j < end; j += 1) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  // 归一化,放大较安静的素材便于观看。
  if (max > 0) {
    for (let i = 0; i < peaks.length; i += 1) {
      peaks[i] = Math.min(1, peaks[i] / max);
    }
  }
  return peaks;
}

export function AudioWaveformPlayer({
  src,
  durationMs,
  onLoadedDuration,
  onPlayingChange,
}: AudioWaveformPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const peaksRef = useRef<Float32Array | null>(peaksCache.get(src) ?? null);

  const [duration, setDuration] = useState(
    typeof durationMs === 'number' && durationMs > 0 ? durationMs / 1000 : 0,
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [peaksVersion, setPeaksVersion] = useState(0);
  const [hovered, setHovered] = useState(false);

  // ---- 播放态外抛 ----------------------------------------------------------
  // 回调走 ref:调用方常传内联箭头函数,直接进依赖会让下面的 effect 每次渲染
  // 重跑,把卸载兜底的 false 误发出去。这个 effect 必须声明在下面那个之前,
  // 同一次提交里 ref 才是新的。
  const onPlayingChangeRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);
  useEffect(() => {
    onPlayingChangeRef.current?.(isPlaying);
    if (!isPlaying) return;
    // 播放中被卸载(视口裁剪 / LOD 换壳)时 <audio> 不会派发 pause 事件,
    // 这里补一次 false,否则外部会留下永久的「播放中」标记。
    return () => {
      onPlayingChangeRef.current?.(false);
    };
  }, [isPlaying]);

  // ---- 解码波形峰值 --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const cached = peaksCache.get(src);
    if (cached) {
      cachePeaks(src, cached); // 刷新到最近使用,避免热素材被 LRU 误淘汰
      peaksRef.current = cached;
      setPeaksVersion((v) => v + 1);
      return;
    }
    peaksRef.current = null;
    void (async () => {
      try {
        const res = await fetch(src);
        const arrayBuffer = await res.arrayBuffer();
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx();
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        void ctx.close();
        if (cancelled) return;
        const peaks = computePeaks(decoded);
        cachePeaks(src, peaks);
        peaksRef.current = peaks;
        if (!Number.isFinite(duration) || duration <= 0) {
          setDuration(decoded.duration);
        }
        setPeaksVersion((v) => v + 1);
      } catch (err) {
        // CORS / 不支持的容器等情况:留空波形,播放仍可用。
        console.warn('[audio-waveform] decode failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // ---- 播放进度驱动 --------------------------------------------------------
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setCurrentTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // ---- 绘制波形 ------------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = parent.clientWidth;
    const cssH = parent.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const peaks = peaksRef.current;
    const center = cssW / 2;
    const midY = cssH / 2;
    const maxBar = cssH * 0.82;
    const totalDuration = duration || 0;

    for (let x = 0; x <= cssW; x += BAR_STEP) {
      const t = currentTime + (x - center) / PX_PER_SEC;
      if (t < 0 || (totalDuration > 0 && t > totalDuration)) continue;
      let amp = 0.12;
      if (peaks && peaks.length > 0 && totalDuration > 0) {
        const idx = Math.min(peaks.length - 1, Math.floor((t / totalDuration) * peaks.length));
        amp = peaks[idx];
      }
      const h = Math.max(2, amp * maxBar);
      ctx.fillStyle = x <= center ? ACCENT : TRACK;
      const radius = BAR_WIDTH / 2;
      const top = midY - h / 2;
      // 圆角条
      ctx.beginPath();
      ctx.roundRect(x - BAR_WIDTH / 2, top, BAR_WIDTH, h, radius);
      ctx.fill();
    }
  }, [currentTime, duration, peaksVersion]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(parent);
    return () => ro.disconnect();
  }, [draw]);

  // ---- 播放控制 ------------------------------------------------------------
  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().then(() => setIsPlaying(true)).catch(() => undefined);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const el = audioRef.current;
      if (!el) return;
      const next = Math.min(duration || el.duration || 0, Math.max(0, el.currentTime + delta));
      el.currentTime = next;
      setCurrentTime(next);
    },
    [duration],
  );

  const seekTo = useCallback(
    (next: number) => {
      const el = audioRef.current;
      const clamped = Math.min(duration || 0, Math.max(0, next));
      if (el) el.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration],
  );

  // ---- 拖拽刷碟(以中心播放头为基准的相对滚动) ----------------------------
  const dragState = useRef<{ startX: number; startTime: number } | null>(null);
  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.shiftKey) return;
      event.stopPropagation();
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      dragState.current = { startX: event.clientX, startTime: currentTime };
    },
    [currentTime],
  );
  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragState.current;
      if (!state) return;
      // 向左拖 → 时间前进(波形向左滚动)。
      const deltaTime = (state.startX - event.clientX) / PX_PER_SEC;
      seekTo(state.startTime + deltaTime);
    },
    [seekTo],
  );
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = null;
      try {
        (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
      } catch {
        /* noop */
      }
    },
    [],
  );

  const timeLabel = `${formatTime(currentTime)}/${formatTime(duration)}`;

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(event) => {
          const el = event.currentTarget;
          if (Number.isFinite(el.duration) && el.duration > 0) {
            setDuration(el.duration);
            onLoadedDuration?.(Math.round(el.duration * 1000));
          }
        }}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
      />

      <div className="flex h-[76%] max-h-[168px] w-full flex-col justify-center">
        {/* 波形刷碟区 */}
        <div className="relative flex h-[52%] min-h-[70px] max-h-[92px] w-full shrink-0 items-center justify-center">
          {/* 左右边缘渐隐 */}
          <div
            className="pointer-events-none absolute inset-0 z-20"
            style={{
              background:
                'linear-gradient(to right, #1f1f1f 0%, transparent 15%, transparent 85%, #1f1f1f 100%)',
            }}
          />
          <div
            ref={scrubRef}
            role="slider"
            aria-label="Audio waveform scrubber"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={currentTime}
            tabIndex={0}
            className="relative z-10 h-full w-full cursor-grab touch-none select-none overflow-visible px-4 active:cursor-grabbing"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <canvas ref={canvasRef} className="block h-full w-full" />

            {/* 中心固定播放头 */}
            <div className="group/head pointer-events-none absolute inset-y-[10%] left-1/2 z-30 flex -translate-x-1/2 flex-col items-center px-1">
              <svg width="10" height="6" viewBox="0 0 10 6" className="shrink-0">
                <path d="M0 0h10L5 6z" fill={ACCENT} />
              </svg>
              <div
                className="w-0.5 flex-1 rounded-full"
                style={{ backgroundColor: ACCENT }}
              />
              <div
                className={`absolute left-1/2 top-full mt-1 flex -translate-x-1/2 flex-col items-center transition-opacity duration-150 ${
                  hovered ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <svg width="8" height="4" viewBox="0 0 8 4" className="-mb-px">
                  <path d="M0 4L4 0l4 4z" fill={ACCENT} />
                </svg>
                <span
                  className="whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium text-white"
                  style={{ backgroundColor: ACCENT }}
                >
                  {timeLabel}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 播放控制 */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pt-3">
          <div className="flex items-center justify-center gap-6">
            <button
              type="button"
              aria-label="rewind 10s"
              className="nodrag flex size-[24px] cursor-pointer items-center justify-center text-[#808080] transition-colors hover:text-white/90"
              onClick={(event) => {
                event.stopPropagation();
                seekBy(-10);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M11.4998 6.3747C11.4998 6.0039 11.4325 5.64145 11.3064 5.33316C11.1804 5.02488 11.0012 4.7846 10.7917 4.64271C10.5821 4.50082 10.3515 4.46369 10.129 4.53601C9.90654 4.60833 9.70217 4.78685 9.54175 5.049L6.1005 10.6743C5.88545 11.0259 5.76465 11.5028 5.76465 12C5.76465 12.4972 5.88545 12.9741 6.1005 13.3257L9.54175 18.951C9.70217 19.2132 9.90654 19.3917 10.129 19.464C10.3515 19.5363 10.5821 19.4992 10.7917 19.3573C11.0012 19.2154 11.1804 18.9751 11.3064 18.6668C11.4325 18.3586 11.4998 17.9961 11.4998 17.6253V6.3747Z"
                fill="#A3A3A3"
              />
              <path
                d="M17.2352 6.3747C17.2352 6.0039 17.1679 5.64145 17.0418 5.33316C16.9158 5.02488 16.7367 4.7846 16.5271 4.64271C16.3175 4.50082 16.0869 4.46369 15.8644 4.53601C15.642 4.60833 15.4376 4.78685 15.2772 5.049L11.8359 10.6743C11.6209 11.0259 11.5001 11.5028 11.5001 12C11.5001 12.4972 11.6209 12.9741 11.8359 13.3257L15.2772 18.951C15.4376 19.2132 15.642 19.3917 15.8644 19.464C16.0869 19.5363 16.3175 19.4992 16.5271 19.3573C16.7367 19.2154 16.9158 18.9751 17.0418 18.6668C17.1679 18.3586 17.2352 17.9961 17.2352 17.6253V6.3747Z"
                fill="#A3A3A3"
              />
            </svg>
            </button>

            <button
              type="button"
              aria-label={isPlaying ? 'pause' : 'play'}
              className="nodrag relative flex size-[36px] cursor-pointer items-center justify-center rounded-full bg-[#E5E5E5] transition-colors hover:bg-white"
              onClick={(event) => {
                event.stopPropagation();
                togglePlay();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
            <div className="relative z-10 flex h-full w-full items-center justify-center text-[#1A1A1A]">
              {isPlaying ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="ml-0.5"
                >
                  <path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" />
                </svg>
              )}
            </div>
            </button>

            <button
              type="button"
              aria-label="fast forward 10s"
              className="nodrag flex size-[24px] cursor-pointer items-center justify-center text-[#808080] transition-colors hover:text-white/90"
              onClick={(event) => {
                event.stopPropagation();
                seekBy(10);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M12.5002 6.3747C12.5002 6.0039 12.5675 5.64145 12.6936 5.33316C12.8196 5.02488 12.9988 4.7846 13.2083 4.64271C13.4179 4.50082 13.6485 4.46369 13.871 4.53601C14.0935 4.60833 14.2978 4.78685 14.4583 5.049L17.8995 10.6743C18.1145 11.0259 18.2354 11.5028 18.2354 12C18.2354 12.4972 18.1145 12.9741 17.8995 13.3257L14.4583 18.951C14.2978 19.2132 14.0935 19.3917 13.871 19.464C13.6485 19.5363 13.4179 19.4992 13.2083 19.3573C12.9988 19.2154 12.8196 18.9751 12.6936 18.6668C12.5675 18.3586 12.5002 17.9961 12.5002 17.6253V6.3747Z"
                fill="#A3A3A3"
              />
              <path
                d="M6.76476 6.3747C6.76481 6.0039 6.83211 5.64145 6.95816 5.33316C7.08421 5.02488 7.26334 4.7846 7.47291 4.64271C7.68248 4.50082 7.91308 4.46369 8.13556 4.53601C8.35804 4.60833 8.56241 4.78685 8.72283 5.049L12.1641 10.6743C12.3791 11.0259 12.4999 11.5028 12.4999 12C12.4999 12.4972 12.3791 12.9741 12.1641 13.3257L8.72283 18.951C8.56241 19.2132 8.35804 19.3917 8.13556 19.464C7.91308 19.5363 7.68248 19.4992 7.47291 19.3573C7.26334 19.2154 7.08421 18.9751 6.95816 18.6668C6.83211 18.3586 6.76481 17.9961 6.76476 17.6253V6.3747Z"
                fill="#A3A3A3"
              />
            </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
