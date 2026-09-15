// SPDX-License-Identifier: Elastic-2.0
import { useEffect } from "react";
import { PIKO_MAP_MUSIC } from "./piko-map-music";
import type { PikoMapId } from "./piko-map-transitions";

const MUSIC_VOLUME = 0.5;
const DUCKED_VOLUME = 0.09;
const REPEAT_PAUSE_MS = 30_000;

/** A separate music channel; survives popup changes, fades out on map disposal. */
export function startPikoMusic(tracks: readonly string[]) {
  if (typeof Audio === "undefined" || tracks.length === 0) return () => {};
  let trackIndex = 0;
  const audio = new Audio(tracks[trackIndex]);
  audio.loop = false;
  audio.preload = "auto";
  audio.volume = 0;
  let disposed = false;
  let playing = false;
  let pending = false;
  let generation = 0;
  let resting = false;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let fadeTimer: ReturnType<typeof setInterval> | undefined;
  let duckTimer: ReturnType<typeof setTimeout> | undefined;
  const fade = (target: number, duration: number, done?: () => void) => {
    clearInterval(fadeTimer);
    const from = audio.volume;
    const start = Date.now();
    fadeTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / duration);
      audio.volume = from + (target - from) * (progress * progress * (3 - 2 * progress));
      if (progress === 1) { clearInterval(fadeTimer); done?.(); }
    }, 25);
  };
  const start = (event?: Event) => {
    const gesture = event?.type === "pointerdown" || event?.type === "keydown" || event?.type === "touchend";
    if (disposed || document.hidden || resting) return;
    // Browsers can pause a silent autoplay when its volume becomes audible.
    if (playing && audio.paused !== true) return;
    if (pending && !gesture) return;
    pending = true;
    const attempt = ++generation;
    try {
      Promise.resolve(audio.play()).then(() => {
        if (attempt !== generation) return;
        if (disposed || document.hidden) { audio.pause(); return; }
        pending = false;
        playing = true;
        fade(MUSIC_VOLUME, 2000);
      }, () => { if (attempt === generation) pending = false; });
    } catch { pending = false; }
  };
  const visibility = () => {
    if (document.hidden) {
      generation++;
      pending = false;
      playing = false;
      clearInterval(fadeTimer);
      clearTimeout(duckTimer);
      audio.pause();
      audio.volume = 0;
    } else start();
  };
  const duck = () => {
    if (!playing || disposed) return;
    clearTimeout(duckTimer);
    fade(Math.min(audio.volume, DUCKED_VOLUME), 150);
    duckTimer = setTimeout(() => fade(MUSIC_VOLUME, 700), 1100);
  };
  const advance = () => {
    trackIndex = (trackIndex + 1) % tracks.length;
    audio.src = tracks[trackIndex];
    audio.currentTime = 0;
    audio.load();
    start();
  };
  const nextTrack = () => {
    if (disposed || resting) return;
    generation++;
    pending = false;
    playing = false;
    clearInterval(fadeTimer);
    clearTimeout(duckTimer);
    audio.volume = 0;
    if (trackIndex === tracks.length - 1) {
      resting = true;
      restTimer = setTimeout(() => {
        resting = false;
        if (!disposed) advance();
      }, REPEAT_PAUSE_MS);
    } else advance();
  };
  audio.addEventListener("ended", nextTrack);
  document.addEventListener("pointerdown", start, true);
  document.addEventListener("keydown", start, true);
  document.addEventListener("touchend", start, true);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("piko-notification-sound", duck);
  start();
  return () => {
    disposed = true;
    audio.removeEventListener("ended", nextTrack);
    clearTimeout(restTimer);
    generation++;
    clearTimeout(duckTimer);
    document.removeEventListener("pointerdown", start, true);
    document.removeEventListener("keydown", start, true);
    document.removeEventListener("touchend", start, true);
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("piko-notification-sound", duck);
    fade(0, 800, () => { audio.pause(); audio.removeAttribute("src"); audio.load(); });
  };
}

// Same playlist identity across related regions prevents restarting a shared track.
export function useMapMusic(mapId: PikoMapId | null) {
  const tracks = mapId ? PIKO_MAP_MUSIC[mapId] : null;
  useEffect(() => tracks ? startPikoMusic(tracks) : undefined, [tracks]);
}
