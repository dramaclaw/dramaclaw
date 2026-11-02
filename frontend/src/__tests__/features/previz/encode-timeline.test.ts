// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  canEncodeOffline,
  encodeTimeline,
  mixTimelineAudio,
  type EncodeTimelineDeps,
  type OfflineAudioContextLike,
} from "@/features/previz/capture/encodeTimeline";
import type { PrevizAudioClip } from "@/features/previz/domain/scene";

function setup(overrides: Partial<EncodeTimelineDeps> = {}) {
  const blob = new Blob(["video"], { type: "video/mp4" });
  const log: string[] = [];
  const encoder = {
    addFrame: vi.fn(async (frame: number) => {
      log.push(`encode${frame}`);
    }),
    finish: vi.fn(async (_audio: AudioBuffer | null) => blob),
    cancel: vi.fn(async () => {}),
  };
  const deps: EncodeTimelineDeps = {
    durationFrames: 4,
    drawFrame: (frame) => log.push(`draw${frame}`),
    encoder,
    yieldToUi: async () => {
      log.push("yield");
    },
    ...overrides,
  };
  return { deps, encoder, blob, log };
}

describe("encodeTimeline", () => {
  it("encodes every frame exactly once, sampling right after each draw", async () => {
    const { deps, encoder, blob, log } = setup({ durationFrames: 2 });

    await expect(encodeTimeline(deps)).resolves.toBe(blob);

    // 画完立刻采，让出主线程排在采样之后：一帧不丢，也采不到被合成清掉的画布。
    expect(log).toEqual([
      "draw0",
      "encode0",
      "yield",
      "draw1",
      "encode1",
      "yield",
      "draw2",
      "encode2",
      "yield",
    ]);
    expect(encoder.finish).toHaveBeenCalledWith(null);
    expect(encoder.cancel).not.toHaveBeenCalled();
  });

  it("reports progress up to exactly 1", async () => {
    const onProgress = vi.fn();
    const { deps } = setup({ durationFrames: 4, onProgress });

    await encodeTimeline(deps);

    expect(onProgress.mock.calls.map(([ratio]) => ratio)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("stops early on request and mixes audio only as long as what was encoded", async () => {
    const audio = {} as AudioBuffer;
    const mixAudio = vi.fn(async (_lastFrame: number) => audio);
    let stop = false;
    const { deps, encoder } = setup({
      durationFrames: 30,
      mixAudio,
      shouldStop: () => stop,
    });
    encoder.addFrame.mockImplementation(async (frame: number) => {
      if (frame === 2) stop = true;
    });

    await encodeTimeline(deps);

    expect(encoder.addFrame).toHaveBeenCalledTimes(3);
    expect(mixAudio).toHaveBeenCalledWith(2);
    expect(encoder.finish).toHaveBeenCalledWith(audio);
  });

  it("still encodes frame 0 when stop was already requested", async () => {
    const { deps, encoder } = setup({ shouldStop: () => true });

    await encodeTimeline(deps);

    expect(encoder.addFrame).toHaveBeenCalledTimes(1);
    expect(encoder.finish).toHaveBeenCalledTimes(1);
  });

  it("releases the encoder and rethrows when a frame fails", async () => {
    const { deps, encoder } = setup();
    encoder.addFrame.mockRejectedValueOnce(new Error("encoder closed"));

    await expect(encodeTimeline(deps)).rejects.toThrow("encoder closed");

    expect(encoder.cancel).toHaveBeenCalledTimes(1);
    expect(encoder.finish).not.toHaveBeenCalled();
  });
});

describe("canEncodeOffline", () => {
  it("is false where WebCodecs is missing, so recording falls back to MediaRecorder", async () => {
    await expect(canEncodeOffline({ width: 1920, height: 1080 })).resolves.toBe(false);
  });
});

function clip(overrides: Partial<PrevizAudioClip>): PrevizAudioClip {
  return {
    id: "clip",
    kind: "audio",
    startFrame: 0,
    endFrame: 30,
    audioUrl: "a.mp3",
    sourceName: "a",
    durationMs: 5000,
    offsetMs: 0,
    sourceNodeId: null,
    ...overrides,
  };
}

function offlineContext() {
  const rendered = {} as AudioBuffer;
  const starts: Array<[number, number, number]> = [];
  const create = vi.fn((_length: number, _sampleRate: number): OfflineAudioContextLike => ({
    destination: {} as AudioNode,
    createBufferSource: () => ({
      buffer: null,
      connect: vi.fn(),
      start: (when = 0, offset = 0, duration = 0) => starts.push([when, offset, duration]),
    }),
    startRendering: async () => rendered,
  }));
  return { create, starts, rendered };
}

describe("mixTimelineAudio", () => {
  const buffer = {} as AudioBuffer;
  const bufferFor = (url: string) => (url === "missing.mp3" ? undefined : buffer);

  it("schedules each clip at its frame, from its material offset", async () => {
    const { create, starts, rendered } = offlineContext();

    const mixed = await mixTimelineAudio(
      [clip({ startFrame: 15, endFrame: 45, offsetMs: 500 })],
      bufferFor,
      2,
      create,
    );

    expect(mixed).toBe(rendered);
    expect(create).toHaveBeenCalledWith(96_000, 48_000);
    expect(starts).toEqual([[0.5, 0.5, 1]]);
  });

  it("skips into the material of a clip that starts before frame 0", async () => {
    const { create, starts } = offlineContext();

    await mixTimelineAudio([clip({ startFrame: -30, endFrame: 30 })], bufferFor, 2, create);

    expect(starts).toEqual([[0, 1, 1]]);
  });

  it("returns null when nothing can be scheduled", async () => {
    const { create } = offlineContext();

    await expect(
      mixTimelineAudio(
        [
          clip({ audioUrl: "missing.mp3" }),
          clip({ startFrame: 90, endFrame: 120 }),
          clip({ startFrame: 10, endFrame: 10 }),
        ],
        bufferFor,
        2,
        create,
      ),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
