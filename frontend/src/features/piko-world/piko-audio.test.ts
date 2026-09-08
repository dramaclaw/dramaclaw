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
