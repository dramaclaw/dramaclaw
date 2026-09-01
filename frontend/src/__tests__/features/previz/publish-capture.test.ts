// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  captureFilename,
  publishCapture,
  type PublishCaptureDeps,
} from "@/features/previz/capture/publishCapture";

function setup(overrides: Partial<PublishCaptureDeps> = {}): PublishCaptureDeps {
  return {
    project: "demo",
    sourceNodeId: "previz-1",
    aspect: "16:9",
    blob: new Blob(["png"], { type: "image/png" }),
    now: () => Date.parse("2026-09-01T12:30:45Z"),
    uploadImage: vi.fn(async () => ({ url: "/static/u/demo/freezone/_uploads/shot.png" })),
    addDerivedUploadNode: vi.fn(() => "upload-1"),
    addEdge: vi.fn(() => "edge-1"),
    ...overrides,
  };
}

describe("captureFilename", () => {
  it("stamps the filename with a sortable timestamp", () => {
    expect(captureFilename(Date.parse("2026-09-01T12:30:45Z"))).toBe("previz-20260901T123045.png");
  });
});

describe("publishCapture", () => {
  it("uploads, creates the downstream node, and connects it", async () => {
    const deps = setup();

    const result = await publishCapture(deps);

    expect(deps.uploadImage).toHaveBeenCalledWith(
      "demo",
      deps.blob,
      "previz-20260901T123045.png",
    );
    // 画幅字符串和画布节点的 aspectRatio 用的是同一套写法（'16:9' / '1:1' …）。
    expect(deps.addDerivedUploadNode).toHaveBeenCalledWith(
      "previz-1",
      "/static/u/demo/freezone/_uploads/shot.png",
      "16:9",
    );
    expect(deps.addEdge).toHaveBeenCalledWith("previz-1", "upload-1");
    expect(result).toEqual({
      ok: true,
      nodeId: "upload-1",
      url: "/static/u/demo/freezone/_uploads/shot.png",
    });
  });

  // 上传挂了别把 Blob 丢掉：重试不用再渲一遍，用户也还能自己存下来。
  it("keeps the blob when the upload fails", async () => {
    const deps = setup({
      uploadImage: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    const result = await publishCapture(deps);

    expect(result).toEqual({ ok: false, reason: "upload", blob: deps.blob });
    expect(deps.addDerivedUploadNode).not.toHaveBeenCalled();
  });

  // addDerivedUploadNode 在源节点已经不在时返回 null；此时连线会指向一个不存在的
  // 目标，画布 store 会把这条边悄悄丢掉，留下一个孤立节点。
  it("reports a node failure without trying to connect anything", async () => {
    const deps = setup({ addDerivedUploadNode: vi.fn(() => null) });

    const result = await publishCapture(deps);

    expect(result).toEqual({ ok: false, reason: "node", blob: deps.blob });
    expect(deps.addEdge).not.toHaveBeenCalled();
  });
});
