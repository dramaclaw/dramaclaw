import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { PIKO_MAP_MUSIC, PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import { PIKO_MAP_TRANSITIONS } from "./piko-map-transitions";
import { startPikoMusic, useMapMusic } from "./piko-bgm";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function mockAudio() {
  const clips: (EventTarget & { src: string; volume: number; loop: boolean; paused: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> })[] = [];
  vi.stubGlobal("Audio", class extends EventTarget {
    volume = 0; loop = false; paused = false;
    play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
    constructor(public src: string) { super(); clips.push(this); }
  });
  return clips;
}
it("covers every map explicitly and keeps the supplied shared groups together", () => {
  expect(Object.keys(PIKO_MAP_MUSIC).sort()).toEqual(Object.keys(PIKO_MAP_TRANSITIONS).sort());
  for (const ids of [["welcome-courtyard", "artisan-market", "wind-garden-gate"], ["lantern-canal-street", "starlight-dock"], ["whispering-meadow", "cloudtop-slope", "amber-wilds"], ["starfall-tidal-wetland", "startrace-coast", "boundless-sea"]] as const) {
    for (const id of ids) expect(PIKO_MAP_MUSIC[id]).toBe(PIKO_MAP_MUSIC[ids[0]]);
  }
  expect(Object.values(PIKO_MAP_MUSIC).every(tracks => tracks && tracks.length > 0)).toBe(true);
  const files = Object.values(PIKO_MUSIC_PLAYLISTS).flat();
  expect(new Set(files).size).toBe(8);
  for (const file of files) expect(readFileSync(`public${file}`).length).toBeGreaterThan(1000);
});
it("preserves shared playback on travel and releases the old channel on a different region", async () => {
  vi.useFakeTimers(); const clips = mockAudio();
  const { rerender, unmount } = renderHook(({ id }) => useMapMusic(id), { initialProps: { id: "whispering-meadow" as keyof typeof PIKO_MAP_MUSIC } });
  await act(async () => {});
  rerender({ id: "cloudtop-slope" }); expect(clips).toHaveLength(1);
  rerender({ id: "crimson-canyon" }); expect(clips).toHaveLength(2);
  expect(clips[1].src).toContain("crimson-canyon.mp3");
  await act(async () => {}); act(() => vi.advanceTimersByTime(800));
  expect(clips[0].removeAttribute).toHaveBeenCalledWith("src");
  unmount(); act(() => vi.advanceTimersByTime(800));
});
it("loops the approved courtyard track and excludes the rejected version", async () => {
  vi.useFakeTimers(); const clips = mockAudio();
  const stop = startPikoMusic(PIKO_MAP_MUSIC["welcome-courtyard"]!);
  await Promise.resolve();
  expect(clips[0].loop).toBe(false);
  expect(clips[0].src).toBe("/piko/world/audio/bgm/welcome-courtyard-01.mp3");
  expect(Object.values(PIKO_MUSIC_PLAYLISTS).flat().some(src => src.includes("courtyard-02"))).toBe(false);
  stop(); vi.advanceTimersByTime(800);
});
