// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Maximize2, Pause, Play, Volume2, VolumeX, X } from 'lucide-react';
import {
  MEDIA_VIEWER_CLOSE_BUTTON_CLASS,
  MEDIA_VIEWER_CLOSE_ICON_CLASS,
} from './closeButtonStyles';

export interface VideoViewerModalProps {
  open: boolean;
  videoUrl: string;
  title?: string;
  onClose: () => void;
}

export function VideoViewerModal({
  open,
  videoUrl,
  title,
  onClose,
}: VideoViewerModalProps): ReactElement | null {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isVisible) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isVisible]);

  useEffect(() => {
    if (open) {
      setIsVisible(true);
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setOverlayOpacity(0);
      requestAnimationFrame(() => {
        setOverlayOpacity(1);
      });
      return;
    }
    if (!isVisible) return;
    setOverlayOpacity(0);
    closeTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      const el = videoRef.current;
      if (el) {
        el.pause();
      }
      setIsPlaying(false);
    }, 320);
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open, isVisible]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!isVisible) return null;

  const togglePlayback = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  };

  const toggleMuted = () => {
    const el = videoRef.current;
    if (!el) return;
    const nextMuted = !el.muted;
    el.muted = nextMuted;
    setMuted(nextMuted);
  };

  const handleSeek = (value: string) => {
    const el = videoRef.current;
    if (!el) return;
    const nextTime = Number(value);
    el.currentTime = Number.isFinite(nextTime) ? nextTime : 0;
    setCurrentTime(el.currentTime);
  };

  const enterFullscreen = () => {
    const el = viewerRef.current;
    if (!el || !el.requestFullscreen) return;
    void el.requestFullscreen();
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={viewerRef}
      className="fixed inset-0 z-[220] overflow-hidden bg-black/96 backdrop-blur-lg"
      style={{
        opacity: overlayOpacity,
        transition: 'opacity 320ms ease',
        pointerEvents: open ? 'auto' : 'none',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between px-6 py-5 text-white">
        <div className="rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-sm font-medium text-white/85 backdrop-blur-xl">
          {title ?? t('viewer.videoTitleFallback')}
        </div>
        <button
          type="button"
          className={`pointer-events-auto ${MEDIA_VIEWER_CLOSE_BUTTON_CLASS}`}
          onClick={onClose}
          title={t('common.close')}
        >
          <X className={MEDIA_VIEWER_CLOSE_ICON_CLASS} />
        </button>
      </div>

      <div
        className="absolute inset-0 flex items-center justify-center px-8 py-24"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          className="max-h-[calc(100vh-11rem)] max-w-[min(92vw,1280px)] rounded-[12px] border border-white/10 bg-black object-contain shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
          style={{ width: 'auto', height: 'auto' }}
          autoPlay
          playsInline
          onClick={(event) => {
            event.stopPropagation();
            togglePlayback();
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration || 0);
            setMuted(event.currentTarget.muted);
          }}
          onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
          onVolumeChange={(event) => setMuted(event.currentTarget.muted)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onEnded={() => setIsPlaying(false)}
        />
      </div>

      <div className="absolute bottom-4 left-1/2 z-20 flex w-[min(92vw,1280px)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-[22px] border border-white/10 bg-black/55 px-3 py-2.5 text-white shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:bottom-6 sm:flex-nowrap sm:gap-3 sm:rounded-full sm:px-4 sm:py-3">
        <button
          type="button"
          onClick={togglePlayback}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/88 transition hover:bg-white/10 hover:text-white"
          aria-label={isPlaying ? t('common.pause') : t('common.play')}
        >
          {isPlaying ? <Pause className="h-[18px] w-[18px]" /> : <Play className="h-[18px] w-[18px]" />}
        </button>
        <span className="w-[72px] shrink-0 text-xs tabular-nums text-white/72">
          {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || currentTime)}
          onChange={(event) => handleSeek(event.target.value)}
          className="h-1 min-w-[160px] flex-1 cursor-pointer appearance-none rounded-full bg-white/18 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
          style={{
            background: `linear-gradient(to right, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.92) ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)`,
          }}
          aria-label={t('viewer.videoSeek')}
        />
        <button
          type="button"
          onClick={toggleMuted}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/78 transition hover:bg-white/10 hover:text-white"
          aria-label={muted ? t('viewer.unmute') : t('viewer.mute')}
        >
          {muted ? <VolumeX className="h-[18px] w-[18px]" /> : <Volume2 className="h-[18px] w-[18px]" />}
        </button>
        <button
          type="button"
          onClick={enterFullscreen}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/78 transition hover:bg-white/10 hover:text-white"
          aria-label={t('viewer.fullscreen')}
        >
          <Maximize2 className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}

function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00';
  }
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}
