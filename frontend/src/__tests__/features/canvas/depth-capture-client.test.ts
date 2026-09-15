// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DepthCaptureError,
  runDepthCaptureInWorker,
} from "@/features/canvas/application/depthCapture/depthCaptureClient";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runDepthCaptureInWorker", () => {
  it("posts the blob, forwards progress and resolves with the result", async () => {
    const source = new Blob(["src"]);
    const onProgress = vi.fn();
    const job = runDepthCaptureInWorker(source, onProgress);
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toEqual([{ type: "run", blob: source }]);

    worker.emit({ type: "progress", progress: 0.4 });
    const out = new Blob(["depth"]);
    worker.emit({ type: "result", blob: out, width: 606, height: 1080, durationMs: 15042 });

    await expect(job.promise).resolves.toEqual({
      blob: out,
      width: 606,
      height: 1080,
      durationMs: 15042,
    });
    expect(onProgress).toHaveBeenCalledWith(0.4);
    expect(worker.terminated).toBe(true);
  });

  it("rejects with the worker's error code", async () => {
    const job = runDepthCaptureInWorker(new Blob(["src"]), vi.fn());
    const worker = FakeWorker.instances[0];
    worker.emit({ type: "error", code: "tooLong", message: "61.0s" });

    await expect(job.promise).rejects.toMatchObject({ code: "tooLong", message: "61.0s" });
    expect(worker.terminated).toBe(true);
  });

  it("cancel terminates the worker and ignores late messages", async () => {
    const onProgress = vi.fn();
    const job = runDepthCaptureInWorker(new Blob(["src"]), onProgress);
    const worker = FakeWorker.instances[0];
    job.cancel();
    worker.emit({ type: "progress", progress: 0.9 });

    const err = await job.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DepthCaptureError);
    expect((err as DepthCaptureError).code).toBe("cancelled");
    expect(worker.terminated).toBe(true);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("maps a worker crash to failed", async () => {
    const job = runDepthCaptureInWorker(new Blob(["src"]), vi.fn());
    const worker = FakeWorker.instances[0];
    worker.onerror?.({ message: "boom" } as ErrorEvent);

    await expect(job.promise).rejects.toMatchObject({ code: "failed", message: "boom" });
    expect(worker.terminated).toBe(true);
  });
});
