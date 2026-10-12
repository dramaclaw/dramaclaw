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
  findActiveDepthCaptureNodeId,
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
      { signal: expect.any(AbortSignal) },
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

  it("runs one job at a time and starts the next when the slot frees up", async () => {
    useCanvasStore.setState({
      nodes: [
        { id: "n1", data: {} },
        { id: "n2", data: {} },
      ],
    } as never);
    const resolvers: Array<() => void> = [];
    vi.mocked(runDepthCaptureInWorker).mockImplementation(() => ({
      promise: new Promise((resolve) => {
        resolvers.push(() =>
          resolve({ blob: new Blob(["depth"]), width: 2, height: 2, durationMs: 1000 }),
        );
      }),
      cancel: vi.fn(),
    }));
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/depth.mp4" } as never);

    const first = startDepthCapture(options);
    const second = startDepthCapture({
      nodeId: "n2",
      projectId: "p1",
      sourceVideoUrl: "https://oss/other.mp4",
    });
    await vi.waitFor(() => expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(1));

    // 排队的任务也算在途：节点不显示「已中断」，同源去重查得到它，但还没取源视频。
    expect(isDepthCaptureActive("n2")).toBe(true);
    expect(findActiveDepthCaptureNodeId("https://oss/other.mp4")).toBe("n2");
    expect(fetch).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await first;
    await vi.waitFor(() => expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(2));
    resolvers[1]();
    await second;

    expect(findActiveDepthCaptureNodeId("https://oss/other.mp4")).toBeNull();
    expect(isDepthCaptureActive("n2")).toBe(false);
  });

  it("drops a queued job when its node is deleted without ever starting a worker", async () => {
    useCanvasStore.setState({
      nodes: [
        { id: "n1", data: {} },
        { id: "n2", data: {} },
      ],
    } as never);
    let finishFirst: () => void = () => {};
    vi.mocked(runDepthCaptureInWorker).mockImplementation(() => ({
      promise: new Promise((resolve) => {
        finishFirst = () =>
          resolve({ blob: new Blob(["depth"]), width: 2, height: 2, durationMs: 1000 });
      }),
      cancel: vi.fn(),
    }));
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/depth.mp4" } as never);

    const first = startDepthCapture(options);
    const queued = startDepthCapture({
      nodeId: "n2",
      projectId: "p1",
      sourceVideoUrl: "https://oss/other.mp4",
    });
    await vi.waitFor(() => expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(1));

    useCanvasStore.setState({ nodes: [{ id: "n1", data: {} }] } as never);
    await queued;
    expect(isDepthCaptureActive("n2")).toBe(false);

    finishFirst();
    await first;
    expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(1);

    // 名额已归还：后面的任务不用等，直接开跑。
    vi.mocked(runDepthCaptureInWorker).mockReturnValue({
      promise: Promise.reject(new DepthCaptureError("failed", "boom")),
      cancel: vi.fn(),
    });
    await startDepthCapture(options);
    expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(2);
  });

  // 中止信号一到就拒绝的受控请求，模拟一笔永远下不完/传不完的慢请求。
  const hangUntilAborted = (signal: AbortSignal | undefined) =>
    new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });

  it("aborts the source download on cancel so the next job is not stuck behind it", async () => {
    useCanvasStore.setState({
      nodes: [
        { id: "n1", data: {} },
        { id: "n2", data: {} },
      ],
    } as never);
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url === "https://oss/src.mp4"
        ? hangUntilAborted(init?.signal ?? undefined)
        : Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(["src"]) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // 轮到时才造这个失败结果：提前建好的 rejected promise 会被当成未处理的拒绝。
    vi.mocked(runDepthCaptureInWorker).mockImplementation(() => ({
      promise: Promise.reject(new DepthCaptureError("failed", "boom")),
      cancel: vi.fn(),
    }));

    const downloading = startDepthCapture(options);
    const queued = startDepthCapture({
      nodeId: "n2",
      projectId: "p1",
      sourceVideoUrl: "https://oss/other.mp4",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 下载还没结束就删掉节点：请求被掐断，名额立刻让给排队的任务。
    useCanvasStore.setState({ nodes: [{ id: "n2", data: {} }] } as never);
    await downloading;
    expect(isDepthCaptureActive("n1")).toBe(false);

    await queued;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://oss/other.mp4");
    expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(1);
  });

  it("aborts the result upload on cancel and frees the slot", async () => {
    vi.mocked(runDepthCaptureInWorker).mockReturnValue({
      promise: Promise.resolve({
        blob: new Blob(["depth"]),
        width: 2,
        height: 2,
        durationMs: 1000,
      }),
      cancel: vi.fn(),
    });
    vi.mocked(uploadFreezoneVideo).mockImplementation(
      (_project, _blob, _name, uploadOptions) => hangUntilAborted(uploadOptions?.signal),
    );

    const uploading = startDepthCapture(options);
    await vi.waitFor(() => expect(uploadFreezoneVideo).toHaveBeenCalled());
    useCanvasStore.setState({ nodes: [] } as never);
    await uploading;

    expect(isDepthCaptureActive("n1")).toBe(false);

    // 名额已归还：新任务直接开跑，不用等那笔被掐断的上传。
    useCanvasStore.setState({ nodes: [{ id: "n1", data: {} }] } as never);
    vi.mocked(runDepthCaptureInWorker).mockReturnValue({
      promise: Promise.reject(new DepthCaptureError("failed", "boom")),
      cancel: vi.fn(),
    });
    await startDepthCapture(options);
    expect(runDepthCaptureInWorker).toHaveBeenCalledTimes(2);
  });
});
