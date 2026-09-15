// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeVideoTrack = {
  canDecode: () => Promise<boolean>;
  getCodec: () => Promise<string>;
  getDisplayWidth: () => Promise<number>;
  getDisplayHeight: () => Promise<number>;
};

const mb = vi.hoisted(() => ({
  videoTrack: null as FakeVideoTrack | null,
  audioCodec: null as string | null,
  initArgs: [] as Array<Record<string, unknown>>,
  discarded: [] as Array<{ track: { type: string }; reason: string }>,
  isValid: true,
  buffer: null as ArrayBuffer | null,
  disposed: 0,
  executeError: null as Error | null,
  // execute() 挂起不resolve，直到被 cancel() 打断——用来模拟「取消发生在
  // execute() 跑到一半」的时序。
  pendingExecute: false,
  executeCalled: false,
  cancelCalled: 0,
  // Conversion.init() 本身没有取消口子（见 cropVideo.ts 注释），要测「取消发生
  // 在 init 期间」这个窗口，只能在 mock 的 init() 内部这一刻回调出去中止 signal。
  onInit: null as (() => void) | null,
}));

vi.mock("mediabunny", () => {
  class BlobSource {}
  class Mp4OutputFormat {}
  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }
  class Output {
    target: BufferTarget;
    constructor(options: { target: BufferTarget }) {
      this.target = options.target;
    }
  }
  class Input {
    async getPrimaryVideoTrack() {
      return mb.videoTrack;
    }
    async getPrimaryAudioTrack() {
      const codec = mb.audioCodec;
      return codec ? { getCodec: async () => codec } : null;
    }
    async computeDuration() {
      return 12.3456;
    }
    dispose() {
      mb.disposed += 1;
    }
  }
  class ConversionCanceledError extends Error {
    constructor(message?: string) {
      super(message ?? "canceled");
      this.name = "ConversionCanceledError";
    }
  }
  const Conversion = {
    async init(args: { output: Output } & Record<string, unknown>) {
      mb.initArgs.push(args);
      mb.onInit?.();
      let rejectExecute: ((error: unknown) => void) | null = null;
      const conversion: {
        isValid: boolean;
        discardedTracks: typeof mb.discarded;
        onProgress?: (progress: number) => void;
        execute: () => Promise<void>;
        cancel: () => Promise<void>;
      } = {
        isValid: mb.isValid,
        discardedTracks: mb.discarded,
        cancel: async () => {
          mb.cancelCalled += 1;
          rejectExecute?.(new ConversionCanceledError("canceled"));
        },
        execute: () => {
          mb.executeCalled = true;
          if (mb.executeError) return Promise.reject(mb.executeError);
          if (mb.pendingExecute) {
            return new Promise<void>((_resolve, reject) => {
              rejectExecute = reject;
            });
          }
          conversion.onProgress?.(1);
          args.output.target.buffer = mb.buffer;
          return Promise.resolve();
        },
      };
      return conversion;
    },
  };
  return {
    ALL_FORMATS: [],
    BlobSource,
    BufferTarget,
    Conversion,
    ConversionCanceledError,
    Input,
    Mp4OutputFormat,
    Output,
    QUALITY_HIGH: "quality-high",
  };
});

import { cropVideoBlob, VideoCropError } from "@/features/canvas/application/videoCrop/cropVideo";

function track(width: number, height: number, decodable = true): FakeVideoTrack {
  return {
    canDecode: async () => decodable,
    getCodec: async () => "avc",
    getDisplayWidth: async () => width,
    getDisplayHeight: async () => height,
  };
}

const BOX = { x: 71.6, y: 127.4, width: 577.9, height: 1025.3 };
const run = (overrides: Partial<Parameters<typeof cropVideoBlob>[0]> = {}) =>
  cropVideoBlob({ blob: new Blob(["src"]), box: BOX, sourceWidth: 720, sourceHeight: 1280, ...overrides });

beforeEach(() => {
  mb.videoTrack = track(720, 1280);
  mb.audioCodec = "aac";
  mb.initArgs = [];
  mb.discarded = [];
  mb.isValid = true;
  mb.buffer = new ArrayBuffer(8);
  mb.disposed = 0;
  mb.executeError = null;
  mb.pendingExecute = false;
  mb.executeCalled = false;
  mb.cancelCalled = 0;
  mb.onInit = null;
});

describe("cropVideoBlob", () => {
  it("crops to even pixels, passes AAC through and reports the output", async () => {
    const onProgress = vi.fn();
    const result = await run({ onProgress });

    expect(mb.initArgs[0]).toMatchObject({
      video: { codec: "avc", bitrate: "quality-high", crop: { left: 72, top: 127, width: 576, height: 1024 } },
      audio: undefined,
      showWarnings: false,
    });
    expect(result).toMatchObject({ width: 576, height: 1024, durationMs: 12346 });
    expect(result.blob.type).toBe("video/mp4");
    expect(result.blob.size).toBe(8);
    expect(onProgress).toHaveBeenCalledWith(1);
    expect(mb.disposed).toBe(1);
  });

  it("re-encodes non web-safe audio to AAC", async () => {
    mb.audioCodec = "pcm-s16";
    await run();
    expect(mb.initArgs[0]).toMatchObject({ audio: { codec: "aac", bitrate: 128_000 } });
  });

  it("rescales the box when the track display size differs from the node metadata", async () => {
    mb.videoTrack = track(1440, 2560);
    const result = await run({ box: { x: 72, y: 128, width: 576, height: 1024 } });
    expect(mb.initArgs[0]).toMatchObject({
      video: { crop: { left: 144, top: 256, width: 1152, height: 2048 } },
    });
    expect(result).toMatchObject({ width: 1152, height: 2048 });
  });

  it("rejects sources the browser cannot decode", async () => {
    mb.videoTrack = track(720, 1280, false);
    await expect(run()).rejects.toMatchObject({ name: "VideoCropError", code: "cannotDecode" });
    expect(mb.initArgs).toHaveLength(0);
    expect(mb.disposed).toBe(1);
  });

  it("rejects files without a video track", async () => {
    mb.videoTrack = null;
    await expect(run()).rejects.toMatchObject({ code: "noVideoTrack" });
  });

  it("rejects oversized sources before opening them", async () => {
    const huge = { size: 900 * 1024 * 1024 } as Blob;
    await expect(run({ blob: huge })).rejects.toMatchObject({ code: "tooLarge" });
    expect(mb.disposed).toBe(0);
  });

  it("fails instead of emitting audio only when the video track is discarded", async () => {
    mb.discarded = [{ track: { type: "video" }, reason: "undecodable_source_codec" }];
    const error = await run().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(VideoCropError);
    expect(error).toMatchObject({ code: "cannotDecode" });
    expect((error as Error).message).toContain("video:undecodable_source_codec");
  });

  it("reports a plain failure (not cannotDecode) when only the encoder is missing", async () => {
    mb.discarded = [{ track: { type: "video" }, reason: "no_encodable_target_codec" }];
    const error = await run().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(VideoCropError);
    expect(error).toMatchObject({ code: "failed" });
    expect((error as Error).message).toContain("video:no_encodable_target_codec");
  });

  it("fails on empty output", async () => {
    mb.buffer = null;
    await expect(run()).rejects.toMatchObject({ code: "failed" });
    expect(mb.disposed).toBe(1);
  });

  it("fails when the conversion is invalid without a discarded video track", async () => {
    mb.isValid = false;
    await expect(run()).rejects.toMatchObject({ code: "failed" });
    expect(mb.disposed).toBe(1);
  });

  it("wraps a plain error thrown from execute", async () => {
    mb.executeError = new Error("boom");
    await expect(run()).rejects.toMatchObject({ name: "VideoCropError", code: "failed", message: "boom" });
    expect(mb.disposed).toBe(1);
  });

  it("rejects immediately with canceled when the signal is already aborted, without touching mediabunny", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(run({ signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(mb.initArgs).toHaveLength(0);
  });

  it("cancels the conversion and reports canceled when the signal aborts mid-execute", async () => {
    mb.pendingExecute = true;
    const controller = new AbortController();

    const promise = run({ signal: controller.signal });
    await vi.waitFor(() => expect(mb.executeCalled).toBe(true));
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "VideoCropError", code: "canceled" });
    expect(mb.cancelCalled).toBe(1);
    expect(mb.disposed).toBe(1);
  });

  it("reports canceled without calling execute when the signal aborts during Conversion.init", async () => {
    // Conversion.init() 没有取消口子，跑完了才能问 signal——这段用例专门盯这条
    // 「init 期间被取消」分支：不是一开始就 aborted（那是上面那条用例），而是
    // init() 正在跑的这段时间里才 abort，得避免白跑一次 execute()。
    const controller = new AbortController();
    mb.onInit = () => controller.abort();

    await expect(run({ signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(mb.executeCalled).toBe(false);
    expect(mb.cancelCalled).toBe(0);
    expect(mb.disposed).toBe(1);
  });
});
