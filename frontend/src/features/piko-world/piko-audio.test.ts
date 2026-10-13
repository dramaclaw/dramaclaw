import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("is lazy, reuses clips, and prevents click sounds piling up", async () => {
  const instances: {pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; currentTime: number}[] = [];
  vi.stubGlobal("Audio", class {
    pause = vi.fn(); play = vi.fn().mockResolvedValue(undefined); currentTime = 9; volume = 1;
    constructor(public src: string) { instances.push(this); }
  });
  const {playPikoUiSound} = await import("./piko-audio");
  expect(instances).toHaveLength(0);
  playPikoUiSound("open"); playPikoUiSound("close"); playPikoUiSound("open");
  expect(instances).toHaveLength(2);
  expect(instances[0].currentTime).toBe(0);
  expect(instances[0].pause).toHaveBeenCalled();
  expect(instances[0].play).toHaveBeenCalledTimes(2);
});
it("tolerates denied playback", async () => {
  vi.stubGlobal("Audio", class { pause() {} play() { return Promise.reject(new Error("denied")); } });
  const {playPikoUiSound} = await import("./piko-audio");
  expect(() => playPikoUiSound("open")).not.toThrow();
  await Promise.resolve();
});
it("plays the supplied notification asset at a restrained volume", async () => {
  const audio = { pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined), currentTime: 0, volume: 1 };
  const sources: string[] = [];
  vi.stubGlobal("Audio", class { constructor(src: string) { sources.push(src); return audio; } });
  const { playPikoUiSound } = await import("./piko-audio");
  playPikoUiSound("notification");
  expect(sources).toEqual(["/piko/world/audio/private-message-notification-v1.mp3"]);
  expect(audio.volume).toBe(0.45);
  expect(audio.play).toHaveBeenCalledTimes(1);
});
it("primes notifications on a gesture and keeps clicks from interrupting them", async () => {
  const instances: { src: string; pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; volume: number }[] = [];
  vi.stubGlobal("Audio", class {
    pause = vi.fn(); play = vi.fn().mockResolvedValue(undefined); currentTime = 0; volume = 1;
    constructor(public src: string) { instances.push(this); }
  });
  const { unlockPikoNotifications, playPikoUiSound } = await import("./piko-audio");
  unlockPikoNotifications();
  expect(instances[0].volume).toBe(0);
  await Promise.resolve();
  expect(instances[0].volume).toBe(0.45);
  playPikoUiSound("notification");
  const pauses = instances[0].pause.mock.calls.length;
  playPikoUiSound("open"); playPikoUiSound("close");
  expect(instances[0].pause).toHaveBeenCalledTimes(pauses);
  unlockPikoNotifications();
  expect(instances.filter(item => item.src.endsWith(".mp3"))).toHaveLength(1);
});
