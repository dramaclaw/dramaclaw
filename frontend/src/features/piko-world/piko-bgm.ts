// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useSyncExternalStore } from "react";
import { PIKO_MAP_MUSIC, PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import type { PikoMapId } from "./piko-map-transitions";

const MUSIC_VOLUME = 1;
const MUSIC_FADE_MS = 3000;
const DUCKED_VOLUME = 0.09;
const REPEAT_PAUSE_MS = 30_000;

// Session preference shared by creation and map music; never recreate the track to mute.
let musicMuted = false;
let selectedTracks: readonly string[] | null = null;
let playback = { src: "", playing: false, error: false, currentTime: 0, duration: 0 };
const STATUS_CHANGE = "piko-music-status";
function reportPlayback(src: string, playing: boolean, error = false) {
  playback = { src, playing, error, currentTime: src === playback.src ? playback.currentTime : 0, duration: src === playback.src ? playback.duration : 0 };
  document.dispatchEvent(new Event(STATUS_CHANGE));
}
/** Start each town visit with scene music, unmuted, and no stale progress. */
export function resetPikoMusicSession() {
  selectedTracks = null;
  musicMuted = false;
  reportPlayback("", false);
  document.dispatchEvent(new Event(MUSIC_CHANGE));
}
export function usePikoPlayback() {
  return useSyncExternalStore(listener => {
    document.addEventListener(STATUS_CHANGE, listener);
    return () => document.removeEventListener(STATUS_CHANGE, listener);
  }, () => playback);
}
export function selectPikoMusic(tracks: readonly string[] | null) {
  selectedTracks = tracks;
  setPikoMusicMuted(false);
}
export function usePikoSelection() {
  return useSyncExternalStore(subscribeMusic, () => selectedTracks, () => null);
}
const MUSIC_CHANGE = "piko-music-change";
export function setPikoMusicMuted(muted: boolean) {
  if (musicMuted === muted) { document.dispatchEvent(new Event(MUSIC_CHANGE)); return; }
  musicMuted = muted;
  document.dispatchEvent(new Event(MUSIC_CHANGE));
}
const subscribeMusic = (listener: () => void) => {
  document.addEventListener(MUSIC_CHANGE, listener);
  return () => document.removeEventListener(MUSIC_CHANGE, listener);
};
export function usePikoMusicMuted() {
  return useSyncExternalStore(subscribeMusic, () => musicMuted, () => false);
}

/** A music channel can retire with a fade while its replacement starts playing. */
export function startPikoMusic(tracks: readonly string[], fadeInMs = 2000) {
  if (typeof Audio === "undefined" || tracks.length === 0) return () => {};
  let trackIndex = 0;
  reportPlayback("", false);
  reportPlayback(tracks[0], false);
  const audio = new Audio(tracks[trackIndex]);
  const updateTime = () => {
    playback = { ...playback, currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0, duration: Number.isFinite(audio.duration) ? audio.duration : 0 };
    document.dispatchEvent(new Event(STATUS_CHANGE));
  };
  audio.addEventListener("timeupdate", updateTime);
  audio.addEventListener("loadedmetadata", updateTime);
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
    if (disposed || musicMuted || resting) return;
    // Browsers can pause a silent autoplay when its volume becomes audible.
    if (playing && audio.paused !== true) return;
    if (pending && !gesture) return;
    pending = true;
    const attempt = ++generation;
    try {
      Promise.resolve(audio.play()).then(() => {
        if (disposed) { audio.pause(); return; }
        if (attempt !== generation) return;
        if (disposed || musicMuted) { audio.pause(); return; }
        pending = false;
        playing = true;
        reportPlayback(tracks[trackIndex], true);
        fade(MUSIC_VOLUME, fadeInMs);
      }, () => { if (attempt === generation) { pending = false; reportPlayback(tracks[trackIndex], false, true); } });
    } catch { pending = false; reportPlayback(tracks[trackIndex], false, true); }
  };
  const syncPreference = (event?: Event) => {
    if (event?.type === MUSIC_CHANGE && !musicMuted && resting) {
      clearTimeout(restTimer); resting = false; advance(); return;
    }
    if (musicMuted) {
      generation++;
      pending = false;
      playing = false;
      clearInterval(fadeTimer);
      clearTimeout(duckTimer);
      audio.pause();
      reportPlayback(tracks[trackIndex], false);
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
    reportPlayback("", false);
    reportPlayback(tracks[trackIndex], false);
    audio.src = tracks[trackIndex];
    audio.currentTime = 0;
    audio.load();
    start();
  };
  const nextTrack = () => {
    reportPlayback(tracks[trackIndex], false);
    if (disposed || resting) return;
    if (selectedTracks === tracks) {
      const library = Object.values(PIKO_MUSIC_PLAYLISTS);
      const index = library.findIndex(list => list[0] === tracks[0]);
      if (index >= 0) { selectPikoMusic(library[(index + 1) % library.length]); return; }
    }
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
  const paused = () => { if (!disposed) reportPlayback(tracks[trackIndex], false); };
  audio.addEventListener("pause", paused);
  const failed = () => {
    generation++; pending = false; playing = false;
    clearInterval(fadeTimer);
    reportPlayback(tracks[trackIndex], false, true);
  };
  audio.addEventListener("error", failed);
  audio.addEventListener("ended", nextTrack);
  document.addEventListener("pointerdown", start, true);
  document.addEventListener("keydown", start, true);
  document.addEventListener("touchend", start, true);
  document.addEventListener(MUSIC_CHANGE, syncPreference);
  document.addEventListener("piko-notification-sound", duck);
  start();
  let released = false;
  let onReleased: (() => void) | undefined;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(fadeTimer);
    document.removeEventListener(MUSIC_CHANGE, muteOutgoing);
    audio.volume = 0; audio.pause(); audio.removeAttribute("src"); audio.load();
    onReleased?.();
  };
  const muteOutgoing = () => { if (musicMuted) release(); };
  return (fadeOutMs = 0, done?: () => void) => {
    if (disposed) { release(); return; }
    onReleased = done;
    disposed = true;
    reportPlayback("", false);
    audio.removeEventListener("timeupdate", updateTime);
    audio.removeEventListener("loadedmetadata", updateTime);
    audio.removeEventListener("error", failed);
    audio.removeEventListener("pause", paused);
    audio.removeEventListener("ended", nextTrack);
    clearTimeout(restTimer);
    generation++;
    clearTimeout(duckTimer);
    document.removeEventListener("pointerdown", start, true);
    document.removeEventListener("keydown", start, true);
    document.removeEventListener("touchend", start, true);
    document.removeEventListener(MUSIC_CHANGE, syncPreference);
    document.removeEventListener("piko-notification-sound", duck);
    clearInterval(fadeTimer);
    if (fadeOutMs > 0 && playing && !musicMuted && audio.volume > 0) {
      document.addEventListener(MUSIC_CHANGE, muteOutgoing);
      fade(0, fadeOutMs, release);
    } else release();
  };
}

// Same playlist identity across related regions prevents restarting a shared track.
export function useMapMusic(mapId: PikoMapId | null) {
  const selected = usePikoSelection();
  const tracks = mapId ? selected ?? PIKO_MAP_MUSIC[mapId] : null;
  const current = useRef<{ tracks: readonly string[]; stop: ReturnType<typeof startPikoMusic> } | null>(null);
  const outgoing = useRef(new Set<ReturnType<typeof startPikoMusic>>());
  useEffect(() => {
    const previous = current.current;
    if (previous?.tracks === tracks) return;
    // Only the immediately preceding channel may overlap the new track.
    outgoing.current.forEach(stop => stop());
    outgoing.current.clear();
    if (previous) {
      outgoing.current.add(previous.stop);
      previous.stop(tracks ? MUSIC_FADE_MS : 0, () => outgoing.current.delete(previous.stop));
    }
    current.current = tracks ? { tracks, stop: startPikoMusic(tracks, previous ? MUSIC_FADE_MS : 2000) } : null;
    if (!tracks) {
      outgoing.current.forEach(stop => stop());
      outgoing.current.clear();
    }
  }, [tracks]);
  useEffect(() => () => {
    current.current?.stop();
    current.current = null;
    outgoing.current.forEach(stop => stop());
    outgoing.current.clear();
  }, []);
}
