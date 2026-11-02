import { useEffect, useRef } from "react";
import { PIKO_ONBOARDING_BACKGROUND } from "./piko-player";
import styles from "./piko-onboarding.module.css";
const VIDEO = "/piko/world/onboarding/welcome-hillside-loop-v1.mp4";
const CROSSFADE_SECONDS = 1.2;

/** Two silent decoders overlap only at the loop seam; the poster covers failures. */
export function PikoCreationBackground({ active }: { active: boolean }) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const clips = [first.current!, second.current!];
    if (!active) { clips.forEach(v => { v.pause(); v.style.opacity = "0"; }); return; }
    let disposed = false, front = 0, switching = false, frame = 0, generation = 0;
    let fadeStart: number | null = null;
    const start = async () => {
      if (disposed || document.hidden) return;
      const token = ++generation;
      try { await clips[front].play(); if (!disposed && token === generation && !document.hidden) clips[front].style.opacity = "1"; else clips[front].pause(); } catch { /* Poster remains; next gesture retries. */ }
    };
    const change = async () => {
      if (switching || disposed || document.hidden) return;
      switching = true;
      const token = generation;
      const back = clips[1 - front];
      back.currentTime = 0;
      try {
        await back.play();
        if (disposed || token !== generation || document.hidden) { back.pause(); return; }
        fadeStart = performance.now();
      } catch { switching = false; }
    };
    const tick = (now: number) => {
      if (disposed) return;
      if (!document.hidden) {
        const current = clips[front];
        if (fadeStart !== null) {
          const progress = Math.min(1, (now - fadeStart) / (CROSSFADE_SECONDS * 1000));
          // Keep the outgoing picture opaque: fading both would expose the poster.
          clips[1 - front].style.zIndex = "1";
          current.style.zIndex = "0";
          clips[1 - front].style.opacity = String(progress);
          if (progress === 1) {
            current.pause(); current.style.opacity = "0";
            front = 1 - front; fadeStart = null; switching = false;
          }
        } else if (Number.isFinite(current.duration) && current.currentTime >= current.duration - CROSSFADE_SECONDS) void change();
      }
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => {
      generation++;
      if (document.hidden) {
        clips.forEach(v => v.pause());
        clips[1 - front].style.opacity = "0";
        fadeStart = null; switching = false;
      } else void start();
    };
    const gesture = () => { if (clips[front].paused && !switching) void start(); };
    const ended = () => { void change(); };
    clips.forEach(v => v.addEventListener("ended", ended));
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerdown", gesture);
    document.addEventListener("keydown", gesture);
    clips[front].currentTime = 0;
    void start(); frame = requestAnimationFrame(tick);
    return () => {
      disposed = true; generation++; cancelAnimationFrame(frame);
      clips.forEach(v => { v.pause(); v.style.opacity = "0"; v.removeEventListener("ended", ended); });
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerdown", gesture);
      document.removeEventListener("keydown", gesture);
    };
  }, [active]);
  return <div className={styles.background} aria-hidden="true">
    <img src={PIKO_ONBOARDING_BACKGROUND} alt="" draggable={false} />
    <video ref={first} src={active ? VIDEO : undefined} muted playsInline preload="auto" />
    <video ref={second} src={active ? VIDEO : undefined} muted playsInline preload="auto" />
  </div>;
}
