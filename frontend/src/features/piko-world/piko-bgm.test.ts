import { afterEach, expect, it, vi } from "vitest";
import { startPikoMusic, setPikoMusicMuted } from "./piko-bgm";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("retries denied playback, fades in and releases on exit", async () => {
 vi.useFakeTimers();
 const audio = Object.assign(new EventTarget(), { volume: 1, loop: false, play: vi.fn().mockRejectedValueOnce(new Error("blocked")).mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() });
 vi.stubGlobal("Audio", class { constructor() { return audio; } });
 const stop = startPikoMusic(["/piko/world/audio/bgm/welcome-courtyard-01.mp3"]);
 await Promise.resolve();
 document.dispatchEvent(new Event("pointerdown"));
 await Promise.resolve();
 vi.advanceTimersByTime(2000);
 expect(audio.volume).toBe(0.7);
 expect(audio.loop).toBe(false);
 document.dispatchEvent(new Event("piko-notification-sound"));
 vi.advanceTimersByTime(150);
 expect(audio.volume).toBeCloseTo(0.09);
 vi.advanceTimersByTime(1800);
 expect(audio.volume).toBe(0.7);
 stop();
 vi.advanceTimersByTime(800);
 expect(audio.volume).toBe(0);
 expect(audio.removeAttribute).toHaveBeenCalledWith("src");
 document.dispatchEvent(new Event("pointerdown"));
 expect(audio.play).toHaveBeenCalledTimes(2);
});
it("continues pending playback without restarting when tab visibility changes", async () => {
 vi.useFakeTimers();
 let hidden = false;
 const visibility = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
 const resolvers: (() => void)[] = [];
 const audio = Object.assign(new EventTarget(), { volume: 0, play: vi.fn(() => new Promise<void>(resolve => resolvers.push(resolve))), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() });
 vi.stubGlobal("Audio", class { constructor() { return audio; } });
 const stop = startPikoMusic(["/piko/world/audio/bgm/welcome-courtyard-01.mp3"]);
 hidden = true; document.dispatchEvent(new Event("visibilitychange"));
 hidden = false; document.dispatchEvent(new Event("visibilitychange"));
 expect(audio.play).toHaveBeenCalledTimes(1);
 const pauses = 0;
 resolvers[0](); await Promise.resolve();
 expect(audio.pause).toHaveBeenCalledTimes(pauses);
 vi.advanceTimersByTime(2000);
 expect(audio.volume).toBe(0.7);
 stop(); vi.advanceTimersByTime(800);
 visibility.mockRestore();
});
it("retries on interaction if the browser paused previously successful autoplay", async () => {
 vi.useFakeTimers();
 const audio = Object.assign(new EventTarget(), { volume: 0, paused: false, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() });
 vi.stubGlobal("Audio", class { constructor() { return audio; } });
 const stop = startPikoMusic(["/piko/world/audio/bgm/welcome-courtyard-01.mp3"]);
 await Promise.resolve();
 audio.paused = true;
 document.dispatchEvent(new Event("pointerdown"));
 await Promise.resolve();
 expect(audio.play).toHaveBeenCalledTimes(2);
 stop(); vi.advanceTimersByTime(800);
});

it("waits 30 seconds between rounds, ignores gestures during the pause and cancels on exit", async () => {
 vi.useFakeTimers();
 const audio = Object.assign(new EventTarget(), { volume: 0, paused: true, currentTime: 12, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() });
 vi.stubGlobal("Audio", class { constructor() { return audio; } });
 const stop = startPikoMusic(["courtyard.mp3"]);
 await Promise.resolve();
 audio.dispatchEvent(new Event("ended"));
 vi.advanceTimersByTime(29999);
 for (const type of ["pointerdown", "keydown", "touchend", "visibilitychange"]) document.dispatchEvent(new Event(type));
 expect(audio.play).toHaveBeenCalledTimes(1);
 expect(audio.volume).toBe(0);
 vi.advanceTimersByTime(1); await Promise.resolve();
 expect(audio.play).toHaveBeenCalledTimes(2); expect(audio.currentTime).toBe(0);
 audio.dispatchEvent(new Event("ended")); stop();
 vi.advanceTimersByTime(31000);
 expect(audio.play).toHaveBeenCalledTimes(2);
 expect(audio.removeAttribute).toHaveBeenCalledWith("src");
});
it("continues repeating in a hidden tab", async () => {
 vi.useFakeTimers();
 let hidden = false;
 const visibility = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
 const audio = Object.assign(new EventTarget(), { volume: 0, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() });
 vi.stubGlobal("Audio", class { constructor() { return audio; } });
 const stop = startPikoMusic(["courtyard.mp3"]);
 try {
  await Promise.resolve(); audio.dispatchEvent(new Event("ended"));
  hidden = true; document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(30000); expect(audio.play).toHaveBeenCalledTimes(2);
  hidden = false; document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve(); expect(audio.play).toHaveBeenCalledTimes(2);
 } finally { stop(); vi.advanceTimersByTime(800); visibility.mockRestore(); }
});
it("pauses after the whole playlist rather than between tracks", async () => {
 vi.useFakeTimers();
 const audio = Object.assign(new EventTarget(), { src: "first.mp3", volume: 0, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() });
 vi.stubGlobal("Audio", class { constructor() { return audio; } });
 const stop = startPikoMusic(["first.mp3", "second.mp3"]);
 await Promise.resolve(); audio.dispatchEvent(new Event("ended")); await Promise.resolve();
 expect(audio.src).toBe("second.mp3"); expect(audio.play).toHaveBeenCalledTimes(2);
 audio.dispatchEvent(new Event("ended")); vi.advanceTimersByTime(29999);
 expect(audio.play).toHaveBeenCalledTimes(2);
 vi.advanceTimersByTime(1); await Promise.resolve();
 expect(audio.src).toBe("first.mp3"); expect(audio.play).toHaveBeenCalledTimes(3);
 stop(); vi.advanceTimersByTime(800);
});

it("mutes without resetting playback and keeps new map music muted", async () => {
 vi.useFakeTimers();
 const clips: Array<{ volume: number; currentTime: number; paused: boolean; play: ReturnType<typeof vi.fn> }> = [];
 vi.stubGlobal("Audio", class extends EventTarget {
  volume = 0; currentTime = 12; paused = true;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  removeAttribute = vi.fn(); load = vi.fn();
  constructor(public src: string) { super(); clips.push(this); }
 });
 const stop = startPikoMusic(["courtyard.mp3"]);
 await Promise.resolve(); vi.advanceTimersByTime(2000);
 setPikoMusicMuted(true);
 expect(clips[0].paused).toBe(true); expect(clips[0].volume).toBe(0);
 document.dispatchEvent(new Event("pointerdown"));
 expect(clips[0].play).toHaveBeenCalledTimes(1);
 setPikoMusicMuted(false); await Promise.resolve();
 expect(clips[0].currentTime).toBe(12);
 expect(clips[0].play).toHaveBeenCalledTimes(2);
 setPikoMusicMuted(true);
 const stopNext = startPikoMusic(["highlands.mp3"]);
 expect(clips[1].play).not.toHaveBeenCalled();
 stop(); stopNext(); vi.advanceTimersByTime(800); setPikoMusicMuted(false);
});
