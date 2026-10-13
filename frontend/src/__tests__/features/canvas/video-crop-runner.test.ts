// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/ops", () => ({ uploadFreezoneVideo: vi.fn() }));
vi.mock("@/features/canvas/application/imageData", () => ({
  resolveImageDisplayUrl: (url: string) => `resolved:${url}`,
}));
vi.mock("@/features/canvas/application/videoCrop/cropVideo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cropVideoBlob: vi.fn(),
}));

import { uploadFreezoneVideo } from "@/api/ops";
import { cropVideoBlob } from "@/features/canvas/application/videoCrop/cropVideo";
import { cropAndUploadVideo } from "@/features/canvas/application/videoCrop/runVideoCrop";

const BOX = { x: 72, y: 128, width: 576, height: 1024 };
const options = {
  projectId: "p1",
  videoUrl: "https://oss/src.mp4",
  box: BOX,
  sourceWidth: 720,
  sourceHeight: 1280,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["src"]) }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(cropVideoBlob).mockReset();
  vi.mocked(uploadFreezoneVideo).mockReset();
});

describe("cropAndUploadVideo", () => {
  it("fetches the source, crops it and uploads the result", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/crop.mp4", filename: "c.mp4", size: 7 });

    const result = await cropAndUploadVideo(options);

    expect(fetchMock).toHaveBeenCalledWith("resolved:https://oss/src.mp4", { signal: undefined });
    expect(cropVideoBlob).toHaveBeenCalledWith(
      expect.objectContaining({ box: BOX, sourceWidth: 720, sourceHeight: 1280, blob: expect.any(Blob) }),
    );
    expect(uploadFreezoneVideo).toHaveBeenCalledWith(
      "p1",
      cropped,
      expect.stringMatching(/^video-crop-\d+\.mp4$/),
      { signal: undefined },
    );
    expect(result).toEqual({ url: "https://oss/crop.mp4", width: 576, height: 1024, durationMs: 5000 });
  });

  it("stops with fetchFailed when the source cannot be downloaded", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, blob: async () => new Blob() });

    await expect(cropAndUploadVideo(options)).rejects.toMatchObject({ code: "fetchFailed", message: "403" });
    expect(cropVideoBlob).not.toHaveBeenCalled();
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("propagates a cropVideoBlob rejection without uploading", async () => {
    const error = new Error("crop failed");
    vi.mocked(cropVideoBlob).mockRejectedValue(error);

    await expect(cropAndUploadVideo(options)).rejects.toBe(error);
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("propagates an uploadFreezoneVideo rejection", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    const error = new Error("upload 500");
    vi.mocked(uploadFreezoneVideo).mockRejectedValue(error);

    await expect(cropAndUploadVideo(options)).rejects.toBe(error);
  });

  it("forwards the abort signal to fetch and cropVideoBlob", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/crop.mp4", filename: "c.mp4", size: 7 });
    const controller = new AbortController();

    await cropAndUploadVideo({ ...options, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith("resolved:https://oss/src.mp4", { signal: controller.signal });
    expect(cropVideoBlob).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(uploadFreezoneVideo).toHaveBeenCalledWith(
      "p1",
      cropped,
      expect.stringMatching(/^video-crop-\d+\.mp4$/),
      { signal: controller.signal },
    );
  });

  it("turns a fetch AbortError into a canceled VideoCropError", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The user aborted a request.", "AbortError"));
    const controller = new AbortController();

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(cropVideoBlob).not.toHaveBeenCalled();
  });

  it("turns a response.blob() AbortError into a canceled VideoCropError", async () => {
    // 取消发生在下载还没读完 body 的时候：fetch() 本身已经 resolve，真正抛
    // AbortError 的是 response.blob() 这一步，必须跟 fetch() 共用同一个
    // abort-mapping try，否则会被当成未知错误走「裁剪失败」而不是「已取消裁剪」。
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
    const controller = new AbortController();

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(cropVideoBlob).not.toHaveBeenCalled();
  });

  it("turns an uploadFreezoneVideo AbortError into a canceled VideoCropError", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    vi.mocked(uploadFreezoneVideo).mockRejectedValue(
      new DOMException("The user aborted a request.", "AbortError"),
    );
    const controller = new AbortController();

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
  });

  it("skips the upload and reports canceled when the signal aborts right after the crop resolves", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    const controller = new AbortController();
    vi.mocked(cropVideoBlob).mockImplementation(async () => {
      // 裁剪算完那一刻用户点了取消——不该再传一份废文件上 OSS。
      controller.abort();
      return { blob: cropped, width: 576, height: 1024, durationMs: 5000 };
    });

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("still lets an in-flight upload finish, then reports canceled once it resolves", async () => {
    // 上传发出去了就收不回来了，中途取消也得等它落地，不然节点没建、文件却已经
    // 在 OSS 上——那样连清理的机会都没有。留档成孤儿是已知取舍。
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    const controller = new AbortController();
    vi.mocked(uploadFreezoneVideo).mockImplementation(async () => {
      controller.abort();
      return { url: "https://oss/crop.mp4", filename: "c.mp4", size: 7 };
    });

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      code: "canceled",
    });
    expect(uploadFreezoneVideo).toHaveBeenCalledTimes(1);
  });
});
