// SPDX-License-Identifier: Elastic-2.0
type UiSound = "open" | "close" | "notification";
const sources: Record<UiSound, string> = {
  open: "/piko/world/audio/ui-open-v1.wav",
  close: "/piko/world/audio/ui-close-v1.wav",
  notification: "/piko/world/audio/private-message-notification-v1.mp3",
};
let current: HTMLAudioElement | undefined;
let notificationUnlocked = false;
let unlockingNotification = false;
let notificationVersion = 0;
const clips = new Map<UiSound, HTMLAudioElement>();

/** Prime the same media element during a gesture for later incoming events. */
export function unlockPikoNotifications() {
  if (notificationUnlocked || unlockingNotification || typeof Audio === "undefined") return;
  try {
    let clip = clips.get("notification");
    if (!clip) { clip = new Audio(sources.notification); clips.set("notification", clip); }
    const element = clip;
    const version = notificationVersion;
    unlockingNotification = true;
    element.volume = 0;
    const finish = () => {
      if (version === notificationVersion) { element.pause(); element.currentTime = 0; element.volume = 0.45; }
      unlockingNotification = false;
    };
    Promise.resolve(element.play()).then(() => { notificationUnlocked = true; finish(); }, finish);
  } catch { unlockingNotification = false; }
}

/** Open/close sounds follow user actions; notification follows a new incoming event. */
export function playPikoUiSound(kind: UiSound) {
  if (typeof Audio === "undefined") return;
  try {
    if (kind !== "notification") current?.pause();
    else { notificationVersion += 1; document.dispatchEvent(new Event("piko-notification-sound")); }
    let clip = clips.get(kind);
    if (!clip) {
      clip = new Audio(sources[kind]);
      clip.volume = kind === "close" ? 0.6 : 0.45;
      clips.set(kind, clip);
    }
    if (kind !== "notification") current = clip;
    else { clip.pause(); clip.volume = 0.45; }
    clip.currentTime = 0;
    void clip.play()?.catch(() => {
      if (kind === "notification") notificationUnlocked = false;
      // A later gesture may unlock media after refresh or browser interruption.
    });
  } catch { /* Unsupported media or browser playback restrictions are non-fatal. */ }
}
