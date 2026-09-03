// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 资产库卡片的画面层：图片直接铺，视频给首帧封面 + 悬停就地预览，音频给一个
// 自绘的小播放器。
//
// 音频过去直接摆原生 <audio controls>——浏览器给的那条灰色胶囊和整个面板的深色
// 皮肤格格不入，还会把卡片下沿的名字挤掉。这里换成「圆形播放键 + 波形进度条 +
// 时间」，和视频卡的播放角标视觉对齐，两种非图片素材看起来才像一套东西。
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Play, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { LibraryItem } from './assetLibraryItems';

/** mm:ss；时长还没读出来时按 0:00 显示，别让卡片上闪一串 NaN。 */
function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/**
 * 同一时间只留一条音轨在响。卡片是网格铺开的，挨个点过去很容易叠成一片噪音，
 * 这里在模块级记着当前那条，新的一播就把旧的按停。
 */
let playingAudio: HTMLAudioElement | null = null;

const WAVEFORM_BARS = 28;

/**
 * 按 URL 生成一串固定的波形高度。
 *
 * 真波形要解码整段音频才画得出来，代价太大；这里只要「每条音轨看起来不一样、
 * 但每次打开都一样」，用 URL 做种子的线性同余就够了。
 */
function waveformHeights(seed: string): number[] {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return Array.from({ length: WAVEFORM_BARS }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 26 + ((state >>> 16) % 74);
  });
}

export interface AssetLibraryItemMediaProps {
  entry: LibraryItem;
}

/** 卡片画面层。外层负责方形容器与选中/删除等浮层，这里只管把内容画满。 */
export function AssetLibraryItemMedia({ entry }: AssetLibraryItemMediaProps) {
  const src = resolveImageDisplayUrl(entry.url);
  if (entry.media === 'video') return <VideoThumb src={src} />;
  if (entry.media === 'audio') return <AudioThumb src={src} />;
  return (
    <img
      src={src}
      alt={entry.name}
      className="h-full w-full object-cover"
      draggable={false}
    />
  );
}

function VideoThumb({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [previewing, setPreviewing] = useState(false);

  // `#t=0.1` 让浏览器 seek 到 0.1 秒并把那一帧画出来当封面；t=0 在部分浏览器
  // 是黑帧。preload=metadata 只拉首帧，不下整段。
  const posterSrc = src.includes('#') ? src : `${src}#t=0.1`;

  const startPreview = () => {
    const el = videoRef.current;
    if (!el) return;
    void el.play().catch(() => undefined);
  };
  const stopPreview = () => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    // 回到封面帧，鼠标划过一排卡片后不会留下一堆停在半截的画面。
    el.currentTime = 0.1;
  };

  return (
    <div
      className="relative h-full w-full"
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
    >
      <video
        ref={videoRef}
        src={posterSrc}
        className="h-full w-full object-cover"
        muted
        loop
        playsInline
        preload="metadata"
        tabIndex={-1}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onPlay={() => setPreviewing(true)}
        onPause={() => setPreviewing(false)}
      />
      {/* 播放角标：预览一起来就淡出，别糊在画面中间。 */}
      <span
        className={`pointer-events-none absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 ring-1 ring-white/25 backdrop-blur-[2px] transition-opacity duration-200 ${
          previewing ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <Play className="ml-0.5 h-4 w-4 text-white" fill="currentColor" />
      </span>
      {duration > 0 && (
        // 摆左下：右下是删除按钮的位置，底边留给名字。
        <span className="pointer-events-none absolute bottom-8 left-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] tabular-nums text-white/90">
          {formatClock(duration)}
        </span>
      )}
    </div>
  );
}

function AudioThumb({ src }: { src: string }) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bars] = useState(() => waveformHeights(src));

  // 播放中用 rAF 推进度：timeupdate 事件一秒才来四次，波形会一格一格地跳。
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 卡片被翻页/切目录换掉时，声音得跟着停——组件没了但 <audio> 还在响是最糟的。
  // 元素移出文档时规范本来也会暂停，但那是副作用不是保证，这里显式停一次。
  useEffect(
    () => () => {
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      if (playingAudio === el) playingAudio = null;
    },
    [],
  );

  // 试听不该顺手把卡片选中；卡片其余部分照旧点了就选。
  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      if (playingAudio && playingAudio !== el) playingAudio.pause();
      playingAudio = el;
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  };

  const seekTo = (event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    const el = audioRef.current;
    if (!el || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const clientX = event.clientX;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setTime(el.currentTime);
  };

  const progress = duration > 0 ? Math.min(1, time / duration) : 0;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2.5 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(120,140,255,0.16),rgba(255,255,255,0.02))] pb-7">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={
          playing
            ? t('canvas.assetLibrary.audioPause')
            : t('canvas.assetLibrary.audioPlay')
        }
        className="flex h-10 w-10 items-center justify-center rounded-full bg-white/92 text-[#15161b] shadow-[0_2px_10px_rgba(0,0,0,0.35)] transition hover:scale-105 hover:bg-white"
      >
        {playing ? (
          <Pause className="h-4 w-4" fill="currentColor" />
        ) : (
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" />
        )}
      </button>

      {/* 波形即进度条：播过的柱子亮起来，点哪跳哪。 */}
      <div
        role="slider"
        aria-label={t('canvas.assetLibrary.audioProgress')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        tabIndex={0}
        onClick={seekTo}
        className="flex h-5 w-[76%] cursor-pointer items-center justify-between gap-px"
      >
        {bars.map((height, index) => (
          <span
            key={index}
            style={{ height: `${height}%` }}
            className={`w-[2px] shrink-0 rounded-full transition-colors ${
              index / bars.length < progress ? 'bg-white/85' : 'bg-white/22'
            }`}
          />
        ))}
      </div>

      <div className="text-[10px] tabular-nums text-white/55">
        {playing || time > 0
          ? `${formatClock(time)} / ${formatClock(duration)}`
          : formatClock(duration)}
      </div>
    </div>
  );
}
