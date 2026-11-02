// SPDX-License-Identifier: Elastic-2.0
import { pointInPolygon, type PikoPoint } from "./navigation-geometry";

type Zone = { id: string; src: string; region: { points: PikoPoint[] }; volume: number; additionalRegions?: { points: PikoPoint[] }[]; fadeDistance?: number; repeatDelay?: number };

export function zoneVolume(point: PikoPoint, zone: Zone): number {
  return Math.max(...[zone.region, ...(zone.additionalRegions ?? [])].map(region => regionVolume(point, zone, region)));
}

function regionVolume(point: PikoPoint, zone: Zone, region: { points: PikoPoint[] }): number {
  const points = region.points;
  if (pointInPolygon(point, points)) return zone.volume;
  let distance = Infinity;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
  });
  const gain = Math.max(0, 1 - distance / (zone.fadeDistance ?? 300));
  return zone.volume * gain * gain * (3 - 2 * gain);
}

/** Quiet spatial ambience, unlocked by input; independent of map loading success. */
export function createEnvironmentAudio(zones: Zone[], resolve: (src: string) => string) {
  // Entering a map is already a user gesture; the listeners below are installed
  // after the asynchronous map load and would otherwise miss that gesture.
  let position: PikoPoint | undefined, disposed = false;
  let unlocked = navigator.userActivation?.hasBeenActive ?? false;
  const clips = zones.map(zone => {
    const audio = new Audio(resolve(zone.src));
    audio.preload = "none"; audio.loop = !zone.repeatDelay; audio.volume = 0;
    const clip = { zone, audio, pending: false, failed: false, blocked: false, waiting: 0 };
    audio.onended = () => { clip.waiting = zone.repeatDelay ?? 0; };
    audio.onerror = () => { clip.failed = true; };
    return clip;
  });
  let focused = document.hasFocus();
  const tick = () => {
    if (disposed || !focused || document.hidden || !unlocked || !position) return;
    const listener = position;
    clips.forEach(clip => {
      const { audio, zone } = clip;
      clip.waiting = Math.max(0, clip.waiting - 0.1);
      const target = zoneVolume(listener, zone); // Full base gain; preserve spatial zone balance and distance falloff.
      audio.volume += (target - audio.volume) * 0.12;
      if (target < 0.001 && audio.volume < 0.002) { audio.volume = 0; audio.pause(); return; }
      if (target <= 0 || !audio.paused || clip.pending || clip.failed || clip.blocked || clip.waiting > 0) return;
      clip.pending = true;
      void audio.play().then(() => {
        if (disposed || !focused || document.hidden || !position || zoneVolume(position, zone) <= 0) audio.pause();
      }).catch(() => { /* Retry this channel on a gesture; other channels remain independent. */ clip.blocked = true; })
        .finally(() => { clip.pending = false; });
    });
  };
  const unlock = () => { unlocked = true; clips.forEach(clip => { clip.blocked = false; }); tick(); };
  const visibility = () => {
    if (!focused || document.hidden) clips.forEach(({ audio }) => { audio.pause(); audio.volume = 0; });
    else tick();
  };
  const blur = () => { focused = false; visibility(); };
  const focus = () => { focused = true; visibility(); };
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
  document.addEventListener("visibilitychange", visibility);
  const timer = window.setInterval(tick, 100);
  return {
    update(point: PikoPoint) { position = { ...point }; },
    destroy() {
      disposed = true; window.clearInterval(timer);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", visibility);
      clips.forEach(({ audio }) => { audio.pause(); audio.onended = null; audio.onerror = null; audio.removeAttribute("src"); audio.load(); });
    },
  };
}
