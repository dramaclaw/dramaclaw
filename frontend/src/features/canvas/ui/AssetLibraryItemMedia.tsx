// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 资产库卡片的画面层：图片直接铺，视频给首帧封面 + 悬停就地预览，音频给一个
// 自绘的小播放器。
//
// 音频过去直接摆原生 <audio controls>——浏览器给的那条灰色胶囊和整个面板的深色
// 皮肤格格不入，还会把卡片下沿的名字挤掉。这里换成「圆形播放键 + 波形进度条 +
// 时间」，和视频卡的播放角标视觉对齐，两种非图片素材看起来才像一套东西。
import { useRef, useState } from 'react';
import { Play } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { LibraryItem } from './assetLibraryItems';
import { AudioPreviewPlayer, formatAudioClock } from '@/components/ui/audio-preview-player';

export interface AssetLibraryItemMediaProps {
  entry: LibraryItem;
}

/** 卡片画面层。外层负责方形容器与选中/删除等浮层，这里只管把内容画满。 */
export function AssetLibraryItemMedia({ entry }: AssetLibraryItemMediaProps) {
  const src = resolveImageDisplayUrl(entry.url);
  if (entry.media === 'video') return <VideoThumb src={src} />;
  if (entry.media === 'audio') return <AudioPreviewPlayer key={src} src={src} layout="card" />;
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
          {formatAudioClock(duration)}
        </span>
      )}
    </div>
  );
}
