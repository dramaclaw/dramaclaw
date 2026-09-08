// SPDX-License-Identifier: Elastic-2.0
type UiSound = "open" | "close";
const sources: Record<UiSound, string> = {
  open: "/piko/world/audio/ui-open-v1.wav",
  close: "/piko/world/audio/ui-close-v1.wav",
};
let current: HTMLAudioElement | undefined;
const clips = new Map<UiSound, HTMLAudioElement>();

/** Call only from a user action, never an effect or an automatic map transition. */
export function playPikoUiSound(kind: UiSound) {
  if (typeof Audio === "undefined") return;
  try {
    current?.pause();
    let clip = clips.get(kind);
    if (!clip) {
      clip = new Audio(sources[kind]);
      clip.volume = kind === "open" ? 0.45 : 0.6;
      clips.set(kind, clip);
    }
    current = clip;
    clip.currentTime = 0;
    void clip.play()?.catch(() => { /* Audio must not block the interaction. */ });
  } catch { /* Unsupported media or browser playback restrictions are non-fatal. */ }
}
