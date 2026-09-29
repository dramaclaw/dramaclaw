// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Local view preferences never grant provider spending authority. */
export function readDirectorPreference<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(`director:ui:${key}`); const parsed: unknown = value ? JSON.parse(value) : fallback;
    return parsed != null && typeof parsed === typeof fallback ? parsed as T : fallback; }
  catch { return fallback; }
}
export function saveDirectorPreference(key: string, value: unknown): boolean {
  try { localStorage.setItem(`director:ui:${key}`, JSON.stringify(value)); return true; }
  catch { return false; }
}
/** Observe transitions only: opening old history must not produce new notifications. */
export function notifyDirectorTask(body: string): void {
  if (!readDirectorPreference<boolean>('notifications', false) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { const notification = new Notification('TV Director', { body, tag: 'director-task-update' });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch { return; }
  if (readDirectorPreference<boolean>('sound', true) && typeof AudioContext !== 'undefined') {
    const context = new AudioContext();
    void context.resume().then(() => {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.06, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.2);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.22);
      oscillator.onended = () => { void context.close(); };
    }).catch(() => { void context.close(); });
  }
}
