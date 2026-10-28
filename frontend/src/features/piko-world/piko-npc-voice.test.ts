// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { playNpcGreeting } from "./piko-npc-voice";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("selects gender voices, interrupts previous playback and isolates old cleanup", () => {
  const clips: MockAudio[] = [];
  class MockAudio {
    pause = vi.fn(); play = vi.fn().mockResolvedValue(undefined); volume = 1;
    constructor(public src: string) { clips.push(this); }
  }
  vi.stubGlobal("Audio", MockAudio);
  const first = playNpcGreeting("m01");
  const second = playNpcGreeting("f01");
  expect(clips[0].src).toContain("npc-male-greeting-v1.mp3");
  expect(clips[0].pause).toHaveBeenCalled();
  expect(clips[1].src).toContain("npc-female-greeting-v1.mp3");
  first();
  expect(clips[1].pause).not.toHaveBeenCalled();
  const third = playNpcGreeting("m02");
  expect(clips[1].pause).toHaveBeenCalled();
  expect(clips[2].src).toContain("npc-male-greeting-v1.mp3");
  second(); third();
});

it("stops when hidden and handles rejected playback", async () => {
  const pause = vi.fn();
  vi.stubGlobal("Audio", class { pause = pause; play = vi.fn().mockRejectedValue(new Error("blocked")); });
  const stop = playNpcGreeting("f01");
  await Promise.resolve();
  expect(pause).toHaveBeenCalledTimes(1);
  stop();
  vi.stubGlobal("Audio", class { pause = pause; play = vi.fn().mockResolvedValue(undefined); });
  playNpcGreeting("m02");
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(pause).toHaveBeenCalledTimes(2);
});
