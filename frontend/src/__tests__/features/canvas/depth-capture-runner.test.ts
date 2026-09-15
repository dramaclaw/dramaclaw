// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/ops", () => ({ uploadFreezoneVideo: vi.fn() }));
vi.mock("@/features/canvas/application/imageData", () => ({
  resolveImageDisplayUrl: (url: string) => url,
}));
vi.mock(
  "@/features/canvas/application/depthCapture/depthCaptureClient",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    runDepthCaptureInWorker: vi.fn(),
  }),
);
vi.mock("@/stores/canvasStore", async () => {
  const { create } = await import("zustand");
  type FakeNode = { id: string; data: Record<string, unknown> };
  const useCanvasStore = create<{
    nodes: FakeNode[];
    updateNodeData: (id: string, data: Record<string, unknown>) => void;
  }>((set) => ({
    nodes: [],
    updateNodeData: (id, data) =>
      set((state) => ({
        nodes: state.nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, ...data } } : node,
        ),
      })),
  }));
  return { useCanvasStore };
});

import { uploadFreezoneVideo } from "@/api/ops";
import {
  DepthCaptureError,
  runDepthCaptureInWorker,
} from "@/features/canvas/application/depthCapture/depthCaptureClient";
import {
  isDepthCaptureActive,
  startDepthCapture,
} from "@/features/canvas/application/depthCapture/runDepthCapture";
import { useCanvasStore } from "@/stores/canvasStore";

const nodeData = () =>
  (useCanvasStore.getState().nodes[0]?.data ?? {}) as Record<string, unknown>;

beforeEach(() => {
  useCanvasStore.setState({ nodes: [{ id: "n1", data: {} }] } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["src"]) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(runDepthCaptureInWorker).mockReset();
  vi.mocked(uploadFreezoneVideo).mockReset();
});

const options = { nodeId: "n1", projectId: "p1", sourceVideoUrl: "https://oss/src.mp4" };

describe("startDepthCapture", () => {
  it("uploads the result and writes it back onto the node", async () => {
    vi.mocked(runDepthCaptureInWorker).mockImplementation((_blob, onProgress) => {
      expect(isDepthCaptureActive("n1")).toBe(true);
      expect(nodeData().depthCapture).toMatchObject({ status: "running", progress: 0 });
      onProgress(0.42);
      expect(nodeData().depthCapture).toMatchObject({ status: "running", progress: 42 });
      return {
        promise: Promise.resolve({
          blob: new Blob(["depth"]),
          width: 606,
          height: 1080,
          durationMs: 15042,
        }),
        cancel: vi.fn(),
      };
    });
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/depth.mp4" } as never);

    await startDepthCapture(options);

    expect(uploadFreezoneVideo).toHaveBeenCalledWith(
      "p1",
      expect.any(Blob),
      expect.stringMatching(/\.mp4$/),
    );
    expect(nodeData()).toMatchObject({
      videoUrl: "https://oss/depth.mp4",
      widthPx: 606,
      heightPx: 1080,
      durationMs: 15042,
      depthCapture: null,
    });
    expect(isDepthCaptureActive("n1")).toBe(false);
  });

  it("records a failed state with the error code", async () => {
    vi.mocked(runDepthCaptureInWorker).mockReturnValue({
      promise: Promise.reject(new DepthCaptureError("tooLong", "61.0s")),
      cancel: vi.fn(),
    });

    await startDepthCapture(options);

    expect(nodeData().depthCapture).toEqual({
      status: "failed",
      progress: 0,
      sourceVideoUrl: "https://oss/src.mp4",
      errorCode: "tooLong",
      errorDetail: "61.0s",
    });
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
    expect(isDepthCaptureActive("n1")).toBe(false);
  });

  it("cancels the worker when the node is deleted", async () => {
    let rejectJob: (err: Error) => void = () => {};
    const cancel = vi.fn(() => rejectJob(new DepthCaptureError("cancelled", "cancelled")));
    vi.mocked(runDepthCaptureInWorker).mockReturnValue({
      promise: new Promise((_, reject) => {
        rejectJob = reject;
      }),
      cancel,
    });

    const run = startDepthCapture(options);
    await vi.waitFor(() => expect(runDepthCaptureInWorker).toHaveBeenCalled());
    useCanvasStore.setState({ nodes: [] } as never);
    await run;

    expect(cancel).toHaveBeenCalled();
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
    expect(isDepthCaptureActive("n1")).toBe(false);
  });
});
