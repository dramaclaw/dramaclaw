// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

export function formatAudioClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

// Asset cards and temporary previews share one active audio track.
let playingAudio: HTMLAudioElement | null = null;

// Preserve the existing asset-card waveform decoration; inline previews use a range.
function waveformHeights(seed: string): number[] {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  return Array.from({ length: 28 }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 26 + ((state >>> 16) % 74);
  });
}

type Props = {
  src?: string;
  durationSeconds?: number;
  disabled?: boolean;
  label?: string;
  playLabel?: string;
  layout?: "card" | "inline";
  onError?: () => void;
};

export function AudioPreviewPlayer({
  src,
  durationSeconds = 0,
  disabled = false,
  label,
  playLabel,
  layout = "inline",
  onError,
}: Props) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [measuredDuration, setMeasuredDuration] = useState(0);
  const duration = measuredDuration || durationSeconds;
  const bars = layout === "card" ? waveformHeights(src ?? "") : [];

  useEffect(() => {
    const audio = audioRef.current;
    setTime(0);
    setMeasuredDuration(0);
    if (disabled) audio?.pause();
    return () => {
      audio?.pause();
      if (playingAudio === audio) playingAudio = null;
    };
  }, [src, disabled]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (audioRef.current) setTime(audioRef.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const unavailable = disabled || !src;
  const seek = (seconds: number) => {
    const next = Math.min(duration, Math.max(0, seconds));
    if (audioRef.current) audioRef.current.currentTime = next;
    setTime(next);
  };
  return (
    <div
      className={layout === "card"
        ? "relative flex h-full w-full flex-col items-center justify-center gap-2.5 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(120,140,255,0.16),rgba(255,255,255,0.02))] pb-7"
        : "flex min-w-0 items-center gap-3 rounded-md bg-muted/30 p-3"}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        aria-label={label}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setMeasuredDuration(value);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={(event) => {
          if (playingAudio && playingAudio !== event.currentTarget) playingAudio.pause();
          playingAudio = event.currentTarget;
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTime(0); }}
        onError={onError}
      />
      <button
        type="button"
        disabled={unavailable}
        aria-label={playing ? t("canvas.assetLibrary.audioPause") : playLabel ?? t("canvas.assetLibrary.audioPlay")}
        onClick={(event) => {
          event.stopPropagation();
          const audio = audioRef.current;
          if (!audio || unavailable) return;
          if (audio.paused) {
            void audio.play().catch(onError ?? (() => undefined));
          } else audio.pause();
        }}
        className={layout === "card"
          ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/92 text-[#15161b] shadow-[0_2px_10px_rgba(0,0,0,0.35)] transition hover:scale-105 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          : "flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition disabled:cursor-not-allowed disabled:opacity-40"}
      >
        {playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
      </button>
      {layout === "card" ? (
        <div
          role="slider"
          aria-label={t("canvas.assetLibrary.audioProgress")}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-disabled={unavailable || duration <= 0}
          tabIndex={unavailable || duration <= 0 ? -1 : 0}
          onClick={(event) => {
            event.stopPropagation();
            if (unavailable || duration <= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width > 0) seek(((event.clientX - rect.left) / rect.width) * duration);
          }}
          onKeyDown={(event) => {
            if (unavailable || duration <= 0) return;
            let target: number;
            switch (event.key) {
              case "Home": target = 0; break;
              case "End": target = duration; break;
              case "ArrowLeft":
              case "ArrowDown": target = time - 1; break;
              case "ArrowRight":
              case "ArrowUp": target = time + 1; break;
              default: return;
            }
            event.preventDefault();
            seek(target);
          }}
          className="flex h-5 w-[76%] cursor-pointer items-center justify-between gap-px"
        >
          {bars.map((height, index) => (
            <span key={index} style={{ height: `${height}%` }} className={`w-[2px] shrink-0 rounded-full transition-colors ${duration > 0 && index / bars.length < time / duration ? "bg-white/85" : "bg-white/22"}`} />
          ))}
        </div>
      ) : <input
        type="range"
        min={0}
        max={duration || 1}
        step={0.01}
        value={Math.min(time, duration || 1)}
        disabled={unavailable || duration <= 0}
        aria-label={t("canvas.assetLibrary.audioProgress")}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          seek(Number(event.target.value));
        }}
        className="h-1 min-w-0 flex-1 accent-primary"
      />}
      <span className={layout === "card" ? "text-[10px] tabular-nums text-white/55" : "shrink-0 text-xs tabular-nums text-muted-foreground"}>
        {layout === "card" && !playing && time <= 0 ? formatAudioClock(duration) : `${formatAudioClock(time)} / ${formatAudioClock(duration)}`}
      </span>
    </div>
  );
}
