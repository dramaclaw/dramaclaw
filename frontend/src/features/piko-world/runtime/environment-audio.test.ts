// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createEnvironmentAudio, zoneVolume } from "./environment-audio";
const zone = { id: "water", src: "water.ogg", volume: 0.4, fadeDistance: 100,
  region: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("fades continuously with distance to the source boundary", () => {
  expect(zoneVolume({ x: 50, y: 50 }, zone)).toBe(0.4);
  expect(zoneVolume({ x: 150, y: 50 }, zone)).toBeCloseTo(0.2);
  expect(zoneVolume({ x: 200, y: 50 }, zone)).toBe(0);
});
it("unlocks on input, spaces bird recordings, pauses in background and releases resources", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const audio = { volume: 0, paused: true, loop: true, preload: "", onended: null as null | (() => void), onerror: null,
    play: vi.fn(async () => { audio.paused = false; }), pause: vi.fn(() => { audio.paused = true; }), removeAttribute: vi.fn(), load: vi.fn() };
  vi.stubGlobal("Audio", class { constructor() { return audio; } });
  const controller = createEnvironmentAudio([{ ...zone, repeatDelay: 25 }], src => src);
  controller.update({ x: 50, y: 50 });
  await vi.advanceTimersByTimeAsync(1000); expect(audio.play).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(audio.play).toHaveBeenCalledTimes(1); expect(audio.volume).toBeGreaterThan(0);
  expect(audio.loop).toBe(false);
  audio.paused = true; audio.onended!();
  await vi.advanceTimersByTimeAsync(24000); expect(audio.play).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1200); expect(audio.play).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("blur"));
  expect(audio.paused).toBe(true); expect(audio.volume).toBe(0);
  await vi.advanceTimersByTimeAsync(1000); expect(audio.play).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(100); expect(audio.play).toHaveBeenCalledTimes(3);
  hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
  expect(audio.volume).toBe(0); expect(audio.paused).toBe(true);
  controller.destroy();
  expect(audio.removeAttribute).toHaveBeenCalledWith("src"); expect(vi.getTimerCount()).toBe(0);
  document.dispatchEvent(new Event("pointerdown")); expect(audio.play).toHaveBeenCalledTimes(3);
});
it("starts ambience when a gesture occurred before the map finished loading", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { userActivation: { hasBeenActive: true } });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const audio = { volume: 0, paused: true, play: vi.fn(async () => { audio.paused = false; }),
    pause: vi.fn(() => { audio.paused = true; }), removeAttribute: vi.fn(), load: vi.fn() };
  vi.stubGlobal("Audio", class { constructor() { return audio; } });
  const controller = createEnvironmentAudio([zone], src => src);
  controller.update({ x: 50, y: 50 });
  await vi.advanceTimersByTimeAsync(200);
  expect(audio.play).toHaveBeenCalledTimes(1);
  controller.destroy();
});
it("waits for the actual spawn position before playing already-unlocked ambience", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { userActivation: { hasBeenActive: true } });
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const audio = { volume: 0, paused: true, play: vi.fn(async () => { audio.paused = false; }),
    pause: vi.fn(() => { audio.paused = true; }), removeAttribute: vi.fn(), load: vi.fn() };
  vi.stubGlobal("Audio", class { constructor() { return audio; } });
  const controller = createEnvironmentAudio([{ ...zone, region: { points: [
    { x: 0, y: 0 }, { x: 2048, y: 0 }, { x: 2048, y: 1152 }, { x: 0, y: 1152 },
  ] } }], src => src);
  try {
    await vi.advanceTimersByTimeAsync(500);
    document.dispatchEvent(new Event("pointerdown"));
    expect(audio.play).not.toHaveBeenCalled();
    controller.update({ x: 50, y: 50 });
    await vi.advanceTimersByTimeAsync(100);
    expect(audio.play).toHaveBeenCalledTimes(1);
  } finally { controller.destroy(); }
});
it("covers separated wind regions without adding overlapping gain", () => {
  const expanded = { ...zone, additionalRegions: [zone.region, { points: zone.region.points.map(p => ({ x: p.x + 400, y: p.y })) }] };
  expect(zoneVolume({ x: 50, y: 50 }, expanded)).toBe(0.4);
  expect(zoneVolume({ x: 450, y: 50 }, expanded)).toBe(0.4);
  expect(zoneVolume({ x: 550, y: 50 }, expanded)).toBeCloseTo(0.2);
  expect(zoneVolume({ x: 250, y: 50 }, expanded)).toBe(0);
});

// Real map placement: insect pockets sit within the four wind regions, away from the plaza.
it("keeps insect ambience local to all four groves", async () => {
  const { default: environment } = await import("../../../../public/piko/world/maps/welcome-courtyard/data/environment.json");
  const insects = environment.audioZones.find(zone => zone.id === "insects")!;
  const wind = environment.audioZones.find(zone => zone.id === "leaves")!;
  for (const region of [insects.region, ...(insects.additionalRegions ?? [])]) {
    const center = { x: region.points.reduce((sum, p) => sum + p.x, 0) / region.points.length,
      y: region.points.reduce((sum, p) => sum + p.y, 0) / region.points.length };
    expect(zoneVolume(center, insects)).toBe(insects.volume);
    expect(zoneVolume(center, wind)).toBe(wind.volume);
    expect(zoneVolume({ x: center.x + 180, y: center.y }, insects)).toBeLessThan(insects.volume);
  }
  // Open public spaces must stay clear of both grove sounds.
  for (const [x, y] of [[1060, 580], [1060, 420], [1190, 485], [1060, 940], [1500, 550], [420, 500], [1830, 570]]) {
    expect(zoneVolume({ x, y }, insects)).toBe(0);
    expect(zoneVolume({ x, y }, wind)).toBe(0);
  }
  // Wind reaches the nearby path; insects remain closer to the undergrowth.
  expect(zoneVolume({ x: 780, y: 850 }, wind)).toBeGreaterThan(0);
  expect(zoneVolume({ x: 720, y: 850 }, insects)).toBeGreaterThan(0);
  expect(zoneVolume({ x: 800, y: 850 }, insects)).toBe(0);
});

it("keeps other channels playing when one channel requires another gesture", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const clips: { paused: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("Audio", class {
    volume = 0; paused = true; loop = false;
    play = vi.fn(async () => { if (clips[0] === this) throw new Error("blocked"); this.paused = false; });
    pause = vi.fn(() => { this.paused = true; });
    removeAttribute() {} load() {}
    constructor() { clips.push(this); }
  });
  const controller = createEnvironmentAudio([{ ...zone, id: "blocked" }, { ...zone, id: "wind" }], src => src);
  controller.update({ x: 50, y: 50 });
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(200);
  controller.update({ x: 400, y: 400 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(clips[1].paused).toBe(true);
  controller.update({ x: 50, y: 50 });
  await vi.advanceTimersByTimeAsync(200);
  expect(clips[1].play).toHaveBeenCalledTimes(2);
  expect(clips[0].play).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(100);
  expect(clips[0].play).toHaveBeenCalledTimes(2);
  controller.destroy();
});

it("pauses a pending playback that resolves after leaving its sound region", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let resolvePlay!: () => void;
  const audio = { volume: 0, paused: true,
    play: vi.fn(() => new Promise<void>(resolve => { resolvePlay = () => { audio.paused = false; resolve(); }; })),
    pause: vi.fn(() => { audio.paused = true; }), removeAttribute: vi.fn(), load: vi.fn() };
  vi.stubGlobal("Audio", class { constructor() { return audio; } });
  const controller = createEnvironmentAudio([zone], src => src);
  controller.update({ x: 50, y: 50 });
  document.dispatchEvent(new Event("pointerdown"));
  controller.update({ x: 400, y: 400 });
  resolvePlay(); await Promise.resolve();
  expect(audio.paused).toBe(true);
  controller.destroy();
});

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });
