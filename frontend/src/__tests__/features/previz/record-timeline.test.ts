// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCanvasRecorder,
  extensionForRecordMime,
  pickRecordMimeType,
  recordFilename,
  recordQualityLabel,
  recordTimeline,
  type RecordTimelineDeps,
} from "@/features/previz/capture/recordTimeline";

/**
 * 假时钟 + 假调度器：`schedule` 一被调用就把时间推进一个间隔再回调，于是整段录制
 * 在测试里是同步走完的，不用真的等 30 帧的墙上时间。
 */
function driver(stepMs: number) {
  let clock = 0;
  return {
    now: () => clock,
    schedule: (callback: () => void) => {
      clock += stepMs;
      // 排进微任务而不是直接调：直接调会把整段录制压成一条几百层深的调用栈。
      void Promise.resolve().then(callback);
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function setup(overrides: Partial<RecordTimelineDeps> = {}) {
  const clock = driver(1000 / 30);
  const blob = new Blob(["video"], { type: "video/mp4" });
  const recorder = { start: vi.fn(), stop: vi.fn(async () => blob) };
  const drawn: number[] = [];
  const deps: RecordTimelineDeps = {
    durationFrames: 6,
    fps: 30,
    drawFrame: (frame) => drawn.push(frame),
    recorder,
    now: clock.now,
    schedule: clock.schedule,
    ...overrides,
  };
  return { deps, drawn, recorder, blob, clock };
}

describe("recordTimeline", () => {
  it("paints frame 0 before the encoder starts, then walks the timeline to the end", async () => {
    const { deps, drawn, recorder, blob } = setup();
    const order: string[] = [];
    recorder.start.mockImplementation(() => order.push("start"));
    const inner = deps.drawFrame;
    deps.drawFrame = (frame) => {
      if (frame === 0) order.push("draw0");
      inner(frame);
    };

    await expect(recordTimeline(deps)).resolves.toBe(blob);

    // 先画后开录：反过来的话编码器开头会采到上一次留在画布上的内容。
    expect(order).toEqual(["draw0", "start"]);
    expect(drawn[0]).toBe(0);
    expect(drawn[drawn.length - 1]).toBe(6);
    // 帧号只增不减，也不越过末帧。
    expect(drawn).toEqual([...drawn].sort((a, b) => a - b));
    expect(Math.max(...drawn)).toBe(6);
  });

  // 渲染跟不上实时的时候丢帧，而不是把动作整体放慢：MediaRecorder 的时间戳来自
  // 墙上时钟，喂慢了录出来就是慢动作。
  it("skips frames instead of stretching time when drawing runs slow", async () => {
    const { deps, drawn } = setup();
    const slow = driver((1000 / 30) * 3);
    deps.now = slow.now;
    deps.schedule = slow.schedule;

    await recordTimeline(deps);

    expect(drawn).toEqual([0, 3, 6]);
  });

  it("stops early and still hands back what was recorded", async () => {
    const { deps, drawn, recorder, blob } = setup({ durationFrames: 300 });
    let ticks = 0;
    deps.shouldStop = () => (ticks += 1) > 3;

    await expect(recordTimeline(deps)).resolves.toBe(blob);

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(drawn[drawn.length - 1]).toBeLessThan(300);
  });

  it("reports progress from 0 to 1", async () => {
    const { deps } = setup();
    const progress: number[] = [];
    deps.onProgress = (ratio) => progress.push(ratio);

    await recordTimeline(deps);

    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(1);
  });

  // 时长为 0 的时间轴不该除出 NaN，也不该一帧都不画。
  it("records a single frame for an empty timeline", async () => {
    const { deps, drawn } = setup({ durationFrames: 0 });
    const progress: number[] = [];
    deps.onProgress = (ratio) => progress.push(ratio);

    await recordTimeline(deps);

    expect(drawn).toEqual([0]);
    expect(progress.every(Number.isFinite)).toBe(true);
  });
});

describe("pickRecordMimeType", () => {
  it("prefers mp4 over webm", () => {
    expect(pickRecordMimeType(() => true)).toBe("video/mp4;codecs=avc1.42E01E");
  });

  it("falls back to webm when mp4 cannot be encoded", () => {
    expect(pickRecordMimeType((type) => type.startsWith("video/webm"))).toBe(
      "video/webm;codecs=vp9",
    );
  });

  it("gives up rather than handing MediaRecorder a type it will reject", () => {
    expect(pickRecordMimeType(() => false)).toBeNull();
  });

  it("prefers a mixed container when audio is wanted", () => {
    expect(pickRecordMimeType(() => true, true)).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(pickRecordMimeType((type) => type.startsWith("video/webm"), true)).toBe(
      "video/webm;codecs=vp9,opus",
    );
  });

  it("returns null when no mixed container is supported so the caller can fall back", () => {
    // 模拟一个只认无声显式编码的浏览器：裸的 video/mp4 / video/webm 也在混音候选里
    // （Safari 只报告裸类型），所以得连它们一起拒掉才算「没有混音容器」。
    const silentOnly = new Set(["video/mp4;codecs=avc1.42E01E", "video/webm;codecs=vp9"]);
    expect(pickRecordMimeType((type) => silentOnly.has(type), true)).toBeNull();
    // 同一个浏览器不带音轨时照常能录：退路是通的。
    expect(pickRecordMimeType((type) => silentOnly.has(type))).toBe(
      "video/mp4;codecs=avc1.42E01E",
    );
  });
});

describe("recordFilename", () => {
  it("stamps a sortable name with the container's extension", () => {
    const now = Date.parse("2026-09-04T10:11:12Z");
    expect(recordFilename(now, "video/mp4")).toBe("previz-record-20260904T101112.mp4");
    expect(recordFilename(now, "video/webm;codecs=vp9")).toBe(
      "previz-record-20260904T101112.webm",
    );
  });

  it("treats anything it cannot name as webm", () => {
    expect(extensionForRecordMime("video/x-matroska")).toBe("webm");
  });
});

describe("recordQualityLabel", () => {
  // 竖幅的「1080p」说的是短边，不是高。
  it("names the short edge, whatever the orientation", () => {
    expect(recordQualityLabel("16:9")).toBe("1080p 16:9");
    expect(recordQualityLabel("9:16")).toBe("1080p 9:16");
    expect(recordQualityLabel("1:1")).toBe("1440p 1:1");
    expect(recordQualityLabel("4:3")).toBe("1200p 4:3");
  });
});

describe("createCanvasRecorder", () => {
  class FakeMediaRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(
      public stream: { getTracks: () => unknown[]; addTrack: (track: unknown) => void },
      public options: { mimeType: string },
    ) {}
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.onstop?.();
    }
  }

  /** 假画布流：记住 addTrack 进来的轨，getTracks 原样吐回去——这样才验得到轨的归属。 */
  function fakeCanvas() {
    const tracks: unknown[] = [];
    const addTrack = vi.fn((track: unknown) => {
      tracks.push(track);
    });
    const canvas = {
      captureStream: () => ({ getTracks: () => tracks, addTrack }),
    } as unknown as HTMLCanvasElement;
    return { canvas, addTrack };
  }

  function fakeAudio() {
    const audioTrack = { kind: "audio", stop: vi.fn() };
    const audioStream = { getAudioTracks: () => [audioTrack] } as unknown as MediaStream;
    return { audioTrack, audioStream };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts the audio tracks of the given stream and stops them with the recording", async () => {
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const { canvas, addTrack } = fakeCanvas();
    const { audioTrack, audioStream } = fakeAudio();

    const recorder = createCanvasRecorder(canvas, {
      fps: 30,
      mimeType: "video/webm",
      audioStream,
    });
    expect(addTrack).toHaveBeenCalledWith(audioTrack);

    recorder.start();
    await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
    // 混音流是为这一次录制建的：录完连音轨一起停，不然音频采集口一直开着。
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the adopted tracks when MediaRecorder cannot be constructed", () => {
    class ThrowingMediaRecorder {
      static isTypeSupported = () => true;
      constructor() {
        throw new Error("NotSupportedError");
      }
    }
    vi.stubGlobal("MediaRecorder", ThrowingMediaRecorder);
    const { canvas } = fakeCanvas();
    const { audioTrack, audioStream } = fakeAudio();

    expect(() =>
      createCanvasRecorder(canvas, { fps: 30, mimeType: "video/webm", audioStream }),
    ).toThrow();
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });
});
