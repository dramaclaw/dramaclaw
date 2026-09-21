// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLENDER_INBOX_POLL_MS, useBlenderInbox } from "@/features/blender/useBlenderInbox";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";

const takeInbox = vi.fn();
// 带上 rest 参数，否则 vi.fn 把入参推成空元组，下面按下标取 calls 全是类型错。
const spawnAssetNode = vi.fn((..._args: unknown[]) => "node-1");

vi.mock("@/features/blender/api", () => ({
  takeBlenderInbox: (project: string) => takeInbox(project),
}));
vi.mock("@/features/canvas/domain/assetDrag", () => ({
  spawnAssetNode: (...args: unknown[]) => spawnAssetNode(...args),
}));
vi.mock("@/features/freezone/spawnToViewport", () => ({
  measureAspectRatio: vi.fn().mockResolvedValue("16:9"),
  spawnedNodeSize: () => ({ width: 320, height: 180 }),
  viewportCenteredPosition: (_store: unknown, index: number) => ({ x: index * 10, y: 0 }),
}));
vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: { getState: () => ({ requestFocusNode: vi.fn() }) },
}));

const READY = {
  // CanvasSyncStatus = "loading" | "ready" | "saving" | "error" | "conflict"。没有 "idle"。
  status: "ready",
  hydratedProject: "demo",
  hydratedCanvasId: "canvas-1",
} as const;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useBlenderInbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    takeInbox.mockReset().mockResolvedValue([]);
    spawnAssetNode.mockClear();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("画布还没 hydrate 完就不发请求——这时候建节点会被 hydrate 覆盖掉", () => {
    renderHook(() =>
      useBlenderInbox({
        projectId: "demo",
        canvasId: "canvas-1",
        sync: { status: "loading", hydratedProject: null, hydratedCanvasId: null },
      }),
    );
    vi.advanceTimersByTime(BLENDER_INBOX_POLL_MS * 3);
    expect(takeInbox).not.toHaveBeenCalled();
  });

  it("画布处于冲突态时不发请求——已经存不进去了，再塞节点只会加重冲突", () => {
    renderHook(() =>
      useBlenderInbox({
        projectId: "demo",
        canvasId: "canvas-1",
        sync: { ...READY, status: "conflict" },
      }),
    );
    vi.advanceTimersByTime(BLENDER_INBOX_POLL_MS * 3);
    expect(takeInbox).not.toHaveBeenCalled();
  });

  it("标签页不可见时不发请求", () => {
    setVisibility("hidden");
    renderHook(() => useBlenderInbox({ projectId: "demo", canvasId: "canvas-1", sync: READY }));
    vi.advanceTimersByTime(BLENDER_INBOX_POLL_MS * 3);
    expect(takeInbox).not.toHaveBeenCalled();
  });

  it("上一次请求没回来就不发下一次", async () => {
    takeInbox.mockReturnValue(new Promise(() => {}));
    renderHook(() => useBlenderInbox({ projectId: "demo", canvasId: "canvas-1", sync: READY }));
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS * 4);
    expect(takeInbox).toHaveBeenCalledTimes(1);
  });

  it("拿到的每一条都建成节点", async () => {
    takeInbox.mockResolvedValueOnce([
      {
        delivery_id: "d1",
        url: "/files/a.png",
        kind: "image",
        filename: "a.png",
        camera: "Camera",
        frame: 1,
        frame_start: null,
        frame_end: null,
        fps: null,
        width: 1920,
        height: 1080,
        created_at: 1,
      },
      {
        delivery_id: "d2",
        url: "/files/b.mp4",
        kind: "video",
        filename: "b.mp4",
        camera: "Camera",
        frame: null,
        frame_start: 1,
        frame_end: 24,
        fps: 24,
        width: 1920,
        height: 1080,
        created_at: 2,
      },
    ]);
    renderHook(() => useBlenderInbox({ projectId: "demo", canvasId: "canvas-1", sync: READY }));
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS);
    // 不用 waitFor：vitest 的假时钟下它只会空转到测试超时（仓库里其余假时钟测试
    // 也一律是 advanceTimers + 直接断言）。这里再推一次 0ms 把建节点那串 await 冲干净。
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnAssetNode).toHaveBeenCalledTimes(2);
    // 取走就是删了，拿到就必须用掉——一条都不能丢。
    expect(spawnAssetNode.mock.calls[0][1]).toMatchObject({ kind: "image", url: "/files/a.png" });
    expect(spawnAssetNode.mock.calls[1][1]).toMatchObject({ kind: "video", url: "/files/b.mp4" });
    // 多条不能叠在一起。
    expect(spawnAssetNode.mock.calls[0][2]).not.toEqual(spawnAssetNode.mock.calls[1][2]);
  });

  it("连续失败 3 次后停表，不再空转", async () => {
    takeInbox.mockRejectedValue(new Error("boom"));
    renderHook(() => useBlenderInbox({ projectId: "demo", canvasId: "canvas-1", sync: READY }));
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS * 6);
    expect(takeInbox).toHaveBeenCalledTimes(3);
  });

  it("会话过期后停表", async () => {
    renderHook(() => useBlenderInbox({ projectId: "demo", canvasId: "canvas-1", sync: READY }));
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS);
    const before = takeInbox.mock.calls.length;
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS * 3);
    expect(takeInbox).toHaveBeenCalledTimes(before);
  });

  it("unmount 之后定时器不再触发", async () => {
    const { unmount } = renderHook(() =>
      useBlenderInbox({ projectId: "demo", canvasId: "canvas-1", sync: READY }),
    );
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS);
    const before = takeInbox.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(BLENDER_INBOX_POLL_MS * 3);
    expect(takeInbox).toHaveBeenCalledTimes(before);
  });
});
