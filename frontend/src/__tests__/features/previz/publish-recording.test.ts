// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  publishRecording,
  type PublishRecordingDeps,
} from "@/features/previz/capture/publishRecording";

function setup(overrides: Partial<PublishRecordingDeps> = {}): PublishRecordingDeps {
  return {
    project: "demo",
    sourceNodeId: "previz-1",
    aspect: "16:9",
    blob: new Blob(["mp4"], { type: "video/mp4" }),
    filename: "previz-record-20260904T101112.mp4",
    displayName: "预演台轨道录制 1(1080p 16:9)",
    uploadVideo: vi.fn(async () => ({ url: "/static/u/demo/freezone/_uploads/take.mp4" })),
    addDerivedVideoNode: vi.fn(() => "video-1"),
    addEdge: vi.fn(() => "edge-1"),
    ...overrides,
  };
}

describe("publishRecording", () => {
  it("uploads, creates the video node with its title, and connects it", async () => {
    const deps = setup();

    const result = await publishRecording(deps);

    expect(deps.uploadVideo).toHaveBeenCalledWith(
      "demo",
      deps.blob,
      "previz-record-20260904T101112.mp4",
    );
    // 画幅字符串和画布节点的 aspectRatio 用的是同一套写法（'16:9' / '1:1' …）。
    expect(deps.addDerivedVideoNode).toHaveBeenCalledWith(
      "previz-1",
      "/static/u/demo/freezone/_uploads/take.mp4",
      "16:9",
      "预演台轨道录制 1(1080p 16:9)",
    );
    expect(deps.addEdge).toHaveBeenCalledWith("previz-1", "video-1");
    expect(result).toEqual({
      ok: true,
      nodeId: "video-1",
      url: "/static/u/demo/freezone/_uploads/take.mp4",
    });
  });

  // 上传挂了别把 Blob 丢掉：一段录制重录一次要花掉整条时间轴的实时时长。
  it("keeps the blob when the upload fails", async () => {
    const deps = setup({
      uploadVideo: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    const result = await publishRecording(deps);

    expect(result).toEqual({ ok: false, reason: "upload", blob: deps.blob });
    expect(deps.addDerivedVideoNode).not.toHaveBeenCalled();
  });

  it("reports a node failure without trying to connect anything", async () => {
    const deps = setup({ addDerivedVideoNode: vi.fn(() => null) });

    const result = await publishRecording(deps);

    expect(result).toEqual({ ok: false, reason: "node", blob: deps.blob });
    expect(deps.addEdge).not.toHaveBeenCalled();
  });
});
