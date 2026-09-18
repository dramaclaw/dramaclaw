// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ANIMAL_AUDIO, animalVolume, createAnimalAudio, type AnimalAudioSource } from "./animal-audio";

class FakeAudio {
  static all: FakeAudio[] = [];
  volume = 0; currentTime = 0; preload = ""; loop = false;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve()); pause = vi.fn();
  removeAttribute = vi.fn(); load = vi.fn();
  constructor(public src: string) { FakeAudio.all.push(this); }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeAudio.all = []; });
function setup(sources: AnimalAudioSource[]) {
  vi.useFakeTimers(); vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const runtime = createAnimalAudio(() => sources, src => src, () => 0);
  runtime.update({ x: 0, y: 0 });
  return runtime;
}
it("fades to silence at each species radius and keeps the cat quieter in a smaller habitat", () => {
  for (const kind of Object.keys(ANIMAL_AUDIO) as (keyof typeof ANIMAL_AUDIO)[]) {
    const spec = ANIMAL_AUDIO[kind];
    expect(animalVolume(kind, 0)).toBe(spec.volume);
    expect(animalVolume(kind, (spec.core + spec.radius) / 2)).toBeCloseTo(spec.volume / 2);
    expect(animalVolume(kind, spec.radius)).toBe(0);
    expect(animalVolume(kind, spec.radius + 100)).toBe(0);
  }
});
it("requires a gesture, serializes nearby voices, respects cooldown and releases media", async () => {
  const runtime = setup([
    { id: "hen", kind: "hen", clip: "henPeck", frame: 0, position: { x: 0, y: 0 } },
    { id: "calf", kind: "calf", clip: "calfGraze", frame: 0, position: { x: 0, y: 0 } },
  ]);
  await vi.advanceTimersByTimeAsync(20000);
  expect(FakeAudio.all.every(audio => audio.play.mock.calls.length === 0)).toBe(true);
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(9000);
  const [hen, calf] = FakeAudio.all;
  expect(hen.play).toHaveBeenCalledTimes(1); expect(calf.play).not.toHaveBeenCalled();
  hen.onended!();
  await vi.advanceTimersByTimeAsync(4000); expect(calf.play).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500); expect(calf.play).toHaveBeenCalledTimes(1);
  calf.onended!(); await vi.advanceTimersByTimeAsync(10000);
  expect(hen.play).toHaveBeenCalledTimes(1);
  runtime.destroy(); runtime.destroy();
  FakeAudio.all.forEach(audio => expect(audio.removeAttribute).toHaveBeenCalledWith("src"));
  expect(vi.getTimerCount()).toBe(0);
});
it("follows a moving dog and never starts a bark outside its bark action or hearing radius", async () => {
  const dog: AnimalAudioSource = { id: "dog", kind: "dog", clip: "dogWalk", frame: 0, position: { x: 0, y: 0 } };
  const runtime = setup([dog]); document.dispatchEvent(new Event("keydown"));
  await vi.advanceTimersByTimeAsync(9000);
  const audio = FakeAudio.all[0]; expect(audio.play).not.toHaveBeenCalled();
  dog.clip = "dogBark"; await vi.advanceTimersByTimeAsync(100);
  expect(audio.play).toHaveBeenCalledTimes(1);
  dog.position = { x: 500, y: 0 }; await vi.advanceTimersByTimeAsync(100);
  expect(audio.volume).toBe(0); expect(audio.pause).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000); expect(audio.play).toHaveBeenCalledTimes(1);
  runtime.destroy();
});
it("aligns the cat voice with entry into the half-closed-eye frame, not every animation tick", async () => {
  const cat: AnimalAudioSource = { id: "cat", kind: "cat", clip: "catIdle", frame: 2, position: { x: 0, y: 0 } };
  const runtime = setup([cat]); document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(9000); expect(FakeAudio.all[0].play).not.toHaveBeenCalled();
  cat.frame = 0; await vi.advanceTimersByTimeAsync(100);
  expect(FakeAudio.all[0].play).toHaveBeenCalledTimes(1);
  FakeAudio.all[0].onended!(); await vi.advanceTimersByTimeAsync(60000);
  expect(FakeAudio.all[0].play).toHaveBeenCalledTimes(1);
  runtime.destroy();
});
it("cancels a pending playback when hidden and prevents late resolution from restarting it", async () => {
  const runtime = setup([{ id: "hen", kind: "hen", clip: "henPeck", frame: 0, position: { x: 0, y: 0 } }]);
  let finish!: () => void;
  FakeAudio.all[0].play.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  document.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(9000);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  const audio = FakeAudio.all[0]; const pauses = audio.pause.mock.calls.length;
  finish(); await Promise.resolve(); expect(audio.pause.mock.calls.length).toBeGreaterThan(pauses);
  expect(audio.volume).toBe(0); runtime.destroy();
});

it("does not let a cancelled pending voice block other animals or revive outside hearing range", async () => {
  const hen: AnimalAudioSource = { id: "hen", kind: "hen", clip: "henPeck", frame: 0, position: { x: 0, y: 0 } };
  const calf: AnimalAudioSource = { id: "calf", kind: "calf", clip: "calfGraze", frame: 0, position: { x: 0, y: 0 } };
  const runtime = setup([hen, calf]);
  let finish!: () => void;
  FakeAudio.all[0].play.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  document.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(9000);
  hen.position = { x: 1000, y: 0 }; await vi.advanceTimersByTimeAsync(6000);
  expect(FakeAudio.all[1].play).toHaveBeenCalledTimes(1);
  finish(); await Promise.resolve();
  expect(FakeAudio.all[0].volume).toBe(0);
  expect(FakeAudio.all[1].volume).toBeGreaterThan(0);
  runtime.destroy();
});

it("rechecks the listener when play resolves before the next timer tick", async () => {
  const runtime = setup([{ id: "hen", kind: "hen", clip: "henPeck", frame: 0, position: { x: 0, y: 0 } }]);
  let finish!: () => void;
  FakeAudio.all[0].play.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  document.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(9000);
  runtime.update({ x: 1000, y: 0 }); finish(); await Promise.resolve();
  expect(FakeAudio.all[0].volume).toBe(0);
  runtime.destroy();
});

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });

it("silences animal voices on window blur and resumes scheduling on focus", async () => {
  const runtime = setup([{ id: "hen", kind: "hen", clip: "henPeck", frame: 0, position: { x: 0, y: 0 } }]);
  document.dispatchEvent(new Event("pointerdown"));
  await vi.advanceTimersByTimeAsync(9000);
  const audio = FakeAudio.all[0];
  expect(audio.play).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("blur"));
  expect(audio.pause).toHaveBeenCalled(); expect(audio.volume).toBe(0);
  await vi.advanceTimersByTimeAsync(60000); expect(audio.play).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(60000); expect(audio.play).toHaveBeenCalledTimes(2);
  runtime.destroy();
});
