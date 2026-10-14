// SPDX-License-Identifier: Elastic-2.0
import type { PikoResidentId } from "./piko-residents";

let stopCurrent: (() => void) | undefined;

/** One NPC voice at a time; the returned cleanup only stops this playback. */
export function playNpcGreeting(residentId: PikoResidentId): () => void {
  stopCurrent?.();
  if (typeof Audio === "undefined") return () => {};
  const gender = residentId.startsWith("f") ? "female" : "male";
  const clip = new Audio(`/piko/world/audio/npc-${gender}-greeting-v1.mp3`);
  clip.volume = 0.7;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clip.pause();
    clip.onended = null;
    clip.onerror = null;
    document.removeEventListener("visibilitychange", visibility);
    if (stopCurrent === stop) stopCurrent = undefined;
  };
  const visibility = () => { if (document.hidden) stop(); };
  stopCurrent = stop;
  clip.onended = stop;
  clip.onerror = stop;
  document.addEventListener("visibilitychange", visibility);
  try { void clip.play().then(() => { if (stopped) clip.pause(); }, stop); }
  catch { stop(); }
  return stop;
}
