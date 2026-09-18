// SPDX-License-Identifier: Elastic-2.0
import { CAT_HEART_FRAME, type AnimalClip, type AnimalKind } from "./courtyard-animals";
import type { PikoPoint } from "./navigation-geometry";

export const ANIMAL_AUDIO = {
  hen: { radius: 220, core: 65, volume: 0.16, cooldown: [35, 60] },
  calf: { radius: 300, core: 85, volume: 0.23, cooldown: [45, 75] },
  cat: { radius: 160, core: 45, volume: 0.18, cooldown: [30, 55] },
  dog: { radius: 300, core: 80, volume: 0.22, cooldown: [20, 35] },
} as const;
type VoicedKind = keyof typeof ANIMAL_AUDIO;
export type AnimalAudioSource = { id: string; kind: AnimalKind; position: PikoPoint; clip: AnimalClip; frame: number };
export function animalVolume(kind: VoicedKind, distance: number): number {
  const spec = ANIMAL_AUDIO[kind];
  const gain = Math.max(0, Math.min(1, (spec.radius - distance) / (spec.radius - spec.core)));
  return spec.volume * gain * gain * (3 - 2 * gain);
}

/** One nearby voice at a time. Actor positions are sampled even while the listener stands still. */
export function createAnimalAudio(sources: () => AnimalAudioSource[], resolve: (src: string) => string,
  random: () => number = Math.random) {
  let listener: PikoPoint | undefined, disposed = false, unlocked = false, quiet = 0;
  const clips = sources().filter(source => source.kind in ANIMAL_AUDIO).map(source => {
    const kind = source.kind as VoicedKind;
    const audio = new Audio(resolve(`animals/${kind}-call-v1.mp3`));
    audio.preload = "none"; audio.loop = false; audio.volume = 0;
    return { id: source.id, kind, audio, waiting: 8 + random() * 10, eligible: false,
      active: false, pending: false, blocked: false, failed: false, generation: 0 };
  });
  type Clip = typeof clips[number];
  const stop = (clip: Clip) => {
    clip.generation++;
    clip.audio.pause(); clip.audio.volume = 0; clip.active = false; clip.pending = false;
    quiet = Math.max(quiet, 5);
  };
  clips.forEach(clip => {
    clip.audio.onended = () => stop(clip);
    clip.audio.onerror = () => { clip.failed = true; stop(clip); };
  });
  let focused = document.hasFocus();
  const tick = () => {
    if (disposed || !focused || document.hidden || !unlocked || !listener) return;
    quiet = Math.max(0, quiet - 0.1);
    const current = new Map(sources().map(source => [source.id, source]));
    for (const clip of clips) {
      clip.waiting = Math.max(0, clip.waiting - 0.1);
      const source = current.get(clip.id);
      const target = source ? animalVolume(clip.kind,
        Math.hypot(source.position.x - listener.x, source.position.y - listener.y)) : 0;
      const eligible = Boolean(source && (clip.kind === "dog" ? source.clip === "dogBark"
        : clip.kind === "cat" ? source.clip === "catIdle" && source.frame === CAT_HEART_FRAME : true));
      const entered = eligible && !clip.eligible;
      clip.eligible = eligible;
      if (clip.active) {
        if (target <= 0 || !eligible) stop(clip);
        else clip.audio.volume += (target - clip.audio.volume) * 0.25;
        continue;
      }
      if (target <= 0.005 || !eligible || ((clip.kind === "cat" || clip.kind === "dog") && !entered)
        || clip.waiting > 0 || quiet > 0 || clip.pending || clip.failed || clip.blocked
        || clips.some(other => other.active || other.pending)) continue;
      const spec = ANIMAL_AUDIO[clip.kind];
      clip.waiting = spec.cooldown[0] + random() * (spec.cooldown[1] - spec.cooldown[0]);
      clip.audio.currentTime = 0; clip.audio.volume = target;
      clip.active = true; clip.pending = true;
      const generation = ++clip.generation;
      void clip.audio.play().then(() => {
        if (generation !== clip.generation) {
          if (!clip.active) clip.audio.pause();
          return;
        }
        const source = sources().find(source => source.id === clip.id);
        if (disposed || !focused || document.hidden || !source || !listener || animalVolume(clip.kind,
          Math.hypot(source.position.x - listener.x, source.position.y - listener.y)) <= 0) stop(clip);
      }).catch(() => {
        if (!disposed && generation === clip.generation) { clip.blocked = true; stop(clip); }
      }).finally(() => { if (generation === clip.generation) clip.pending = false; });
    }
  };
  const unlock = () => { unlocked = true; clips.forEach(clip => { clip.blocked = false; }); };
  const visibility = () => { if (!focused || document.hidden) clips.forEach(stop); };
  const blur = () => { focused = false; visibility(); };
  const focus = () => { focused = true; visibility(); };
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
  document.addEventListener("visibilitychange", visibility);
  const timer = window.setInterval(tick, 100);
  return {
    update(point: PikoPoint) { listener = { ...point }; },
    destroy() {
      if (disposed) return;
      disposed = true; window.clearInterval(timer);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", visibility);
      clips.forEach(clip => {
        stop(clip); clip.audio.onended = null; clip.audio.onerror = null;
        clip.audio.removeAttribute("src"); clip.audio.load();
      });
    },
  };
}
